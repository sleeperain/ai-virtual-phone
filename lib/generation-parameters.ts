import type { ApiConfig, GenerationParameterKey, PresetConfig } from "./settings-types";

export const GENERATION_PARAMETER_KEYS: readonly GenerationParameterKey[] = [
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "top_a",
    "repetition_penalty",
    "frequency_penalty",
    "presence_penalty",
    "max_tokens",
];

const GENERATION_PARAMETER_KEY_SET = new Set<GenerationParameterKey>(GENERATION_PARAMETER_KEYS);

export function isGenerationParameterKey(value: unknown): value is GenerationParameterKey {
    return typeof value === "string" && GENERATION_PARAMETER_KEY_SET.has(value as GenerationParameterKey);
}

/**
 * Old presets did not store an allow-list. Derive the list from the exact legacy
 * request behavior so simply upgrading does not add or remove request fields.
 */
export function resolveEnabledGenerationParameters(
    preset: PresetConfig | null,
): Set<GenerationParameterKey> {
    if (preset?.enabled_generation_parameters) {
        return new Set(preset.enabled_generation_parameters.filter(isGenerationParameterKey));
    }

    const enabled = new Set<GenerationParameterKey>([
        "temperature",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
    ]);
    if (!preset) return enabled;
    if (preset.top_k > 0) enabled.add("top_k");
    if ((preset.min_p ?? 0) > 0) enabled.add("min_p");
    if ((preset.top_a ?? 0) > 0) enabled.add("top_a");
    if (preset.repetition_penalty !== undefined && preset.repetition_penalty !== 1) {
        enabled.add("repetition_penalty");
    }
    if (preset.openai_max_tokens > 0) enabled.add("max_tokens");
    return enabled;
}

/** 各家默认值：字段缺省时用它兜底，和迁移前的硬编码取值保持一致。 */
export const GENERATION_PARAMETER_FALLBACKS: Record<GenerationParameterKey, number> = {
    temperature: 0.8,
    top_p: 1,
    top_k: 0,
    min_p: 0,
    top_a: 0,
    repetition_penalty: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
    max_tokens: 0,
};

export type ResolvedGenerationParameters = {
    /** 这一轮实际要发出的参数集合 */
    enabled: Set<GenerationParameterKey>;
    /** 每个参数的取值（未启用的也有值，只是不发送） */
    values: Record<GenerationParameterKey, number>;
    /** 参数来源：api=API 配置；preset=预设（旧行为） */
    source: "api" | "preset";
};

function readPresetValues(preset: PresetConfig | null): Record<GenerationParameterKey, number> {
    return {
        temperature: preset?.temperature ?? GENERATION_PARAMETER_FALLBACKS.temperature,
        top_p: preset?.top_p ?? GENERATION_PARAMETER_FALLBACKS.top_p,
        top_k: preset?.top_k ?? GENERATION_PARAMETER_FALLBACKS.top_k,
        min_p: preset?.min_p ?? GENERATION_PARAMETER_FALLBACKS.min_p,
        top_a: preset?.top_a ?? GENERATION_PARAMETER_FALLBACKS.top_a,
        repetition_penalty: preset?.repetition_penalty ?? GENERATION_PARAMETER_FALLBACKS.repetition_penalty,
        frequency_penalty: preset?.frequency_penalty ?? GENERATION_PARAMETER_FALLBACKS.frequency_penalty,
        presence_penalty: preset?.presence_penalty ?? GENERATION_PARAMETER_FALLBACKS.presence_penalty,
        max_tokens: preset?.openai_max_tokens ?? GENERATION_PARAMETER_FALLBACKS.max_tokens,
    };
}

export const DEFAULT_ENABLED_GENERATION_PARAMETERS: readonly GenerationParameterKey[] = [
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
];

/**
 * 生成参数的解析入口：生成参数统一由 API 配置管理（不再从预设读取，避免旧预设里的残留温度/惩罚值串进 API 请求）。
 * 若某条旧 API 配置尚未编辑过 generationParameters，则使用全局默认参数与默认启用集合。
 */
export function resolveGenerationParameters(
    config: ApiConfig | null | undefined,
    preset?: PresetConfig | null,
    /** 单次调用覆盖（聊天插件 llm.request 改写、工坊输出护栏等），优先级最高 */
    overrides?: Partial<Record<GenerationParameterKey, number>>,
): ResolvedGenerationParameters {
    void preset;
    const fromApi = config?.generationParameters;
    const values: Record<GenerationParameterKey, number> = { ...GENERATION_PARAMETER_FALLBACKS };

    if (fromApi) {
        for (const key of GENERATION_PARAMETER_KEYS) {
            const value = fromApi[key];
            if (typeof value === "number" && Number.isFinite(value)) values[key] = value;
        }
    }

    const enabled = fromApi?.enabled
        ? new Set(fromApi.enabled.filter(isGenerationParameterKey))
        : new Set<GenerationParameterKey>(DEFAULT_ENABLED_GENERATION_PARAMETERS);

    const resolved: ResolvedGenerationParameters = { enabled, values, source: "api" };

    if (overrides) {
        for (const key of GENERATION_PARAMETER_KEYS) {
            const value = overrides[key];
            if (typeof value !== "number" || !Number.isFinite(value)) continue;
            resolved.values[key] = value;
            resolved.enabled.add(key);
        }
    }
    return resolved;
}
