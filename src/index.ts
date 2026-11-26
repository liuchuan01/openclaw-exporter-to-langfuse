import { join } from "node:path";
import os from "node:os";
import { LangfuseExporter } from "./langfuse-exporter.js";
import { createRunTracer, TRACE_HOOKS } from "./run-tracer.js";
import {
  detectSkillTagsFromToolCall,
  resolveSkillTagDetectionConfig,
} from "./skill-tagging.js";
import type { Message } from "./messages.js";
import type {
  OpenClawPlugin,
  OpenClawPluginApi,
  LangfuseTraceConfig,
} from "./types.js";
import { PLUGIN_VERSION } from "./version.js";
import {
  createEvaluationBridge,
  registerEvaluationMethods,
} from "./evaluation.js";

const langfuseTracePlugin: OpenClawPlugin = {
  id: "openclaw-exporter-to-langfuse",
  name: "OpenClaw Exporter to Langfuse",
  version: PLUGIN_VERSION,
  description:
    "Export OpenClaw AI agent execution traces to Langfuse via OpenTelemetry",

  register(api: OpenClawPluginApi) {
    const settings = api.pluginConfig ?? {};
    const endpoint = settings.endpoint as string;
    const headers = settings.headers as Record<string, string>;
    if (!endpoint || !headers?.Authorization) {
      api.logger.error(
        "[LangfuseTrace] Required configuration: endpoint and headers.Authorization",
      );
      return;
    }
    if (
      Array.isArray(settings.enabledHooks) &&
      TRACE_HOOKS.some(
        (name) => !(settings.enabledHooks as string[]).includes(name),
      )
    ) {
      throw new Error(
        "Langfuse tracing requires all lifecycle hooks; remove enabledHooks from the plugin configuration",
      );
    }
    const config: LangfuseTraceConfig = {
      endpoint,
      headers,
      serviceName: (settings.serviceName as string) || "openclaw-agent",
      debug: settings.debug === true,
      batchSize: Math.max(1, Math.min(100, Number(settings.batchSize) || 10)),
      flushIntervalMs: Math.max(100, Number(settings.flushIntervalMs) || 5000),
    };
    let userId =
      typeof settings.userId === "string" ? settings.userId.trim() : "";
    if (!userId) {
      try {
        userId = os.userInfo().username;
      } catch {
        userId = "unknown";
      }
    }
    const tags = Array.isArray(settings.tags)
      ? [
          ...new Set(
            settings.tags
              .filter((tag): tag is string => typeof tag === "string")
              .map((tag) => tag.trim())
              .filter(Boolean),
          ),
        ]
      : [];
    const skills = resolveSkillTagDetectionConfig(settings);
    const exporter = new LangfuseExporter(api, config);
    const evaluation =
      settings.evaluationEnabled === true
        ? createEvaluationBridge({
            storeDirectory: join(
              api.runtime?.state?.resolveStateDir?.() ??
                (() => {
                  throw new Error(
                    "Evaluation persistence requires runtime.state.resolveStateDir",
                  );
                })(),
              "plugins",
              "openclaw-exporter-to-langfuse",
              "evaluations",
            ),
            resultTtlMs: settings.evaluationResultTtlMs as number | undefined,
            preparedTimeoutMs: settings.evaluationPreparedTimeoutMs as
              number | undefined,
            maxEntries: settings.evaluationMaxEntries as number | undefined,
          })
        : undefined;
    if (evaluation) registerEvaluationMethods(api, evaluation);
    const tracer = createRunTracer(exporter, {
      userId,
      tags,
      openclawVersion: api.runtime?.version,
      requestContext: evaluation?.claim,
      onRunFinished: evaluation?.finish,
      warn: (message) => api.logger.warn(message),
      toolAttributes(name, params): Record<string, string | number | boolean> {
        const detected = skills
          ? detectSkillTagsFromToolCall(name, params, skills)
          : [];
        return detected.length
          ? {
              "langfuse.tags": JSON.stringify(detected),
              "langfuse.observation.metadata.skills": JSON.stringify(detected),
            }
          : {};
      },
    });
    for (const name of TRACE_HOOKS) {
      api.on<Message>(name, (event, context) => {
        try {
          tracer.handle(name, event, context);
        } catch (error) {
          api.logger.warn(
            `[LangfuseTrace] Could not observe ${name}: ${String(error)}`,
          );
        }
      });
    }
    const events = api.runtime?.events;
    if (!events?.onAgentEvent) {
      throw new Error(
        "Langfuse tracing requires runtime.events.onAgentEvent for execution settlement",
      );
    }
    let unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    api.registerService({
      id: "openclaw-exporter-to-langfuse",
      async start() {
        evaluation?.start();
        await exporter.ensureInitialized();
        unsubscribe = events.onAgentEvent(tracer.handleAgentEvent);
        timer = setInterval(() => {
          void tracer.sweep();
          try {
            evaluation?.sweep();
          } catch (error) {
            api.logger.error(
              `[LangfuseTrace] Evaluation cleanup failed: ${String(error)}`,
            );
          }
        }, 60_000);
        timer.unref();
      },
      async stop() {
        clearInterval(timer);
        unsubscribe?.();
        await tracer.drain();
        try {
          evaluation?.stop();
        } finally {
          try {
            await tracer.stop();
          } finally {
            await exporter.dispose();
          }
        }
      },
    });
    api.logger.info(
      `[LangfuseTrace] Registered OpenClaw tracing (service=${config.serviceName})`,
    );
  },
};

export default langfuseTracePlugin;
