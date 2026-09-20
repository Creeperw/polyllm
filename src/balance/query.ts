import type { HFModelItem, ProviderBalanceConfig } from "../types";
import { VersionManager } from "../versionManager";
import { BalanceExpressionError, evaluateBalanceNumber, evaluateBalanceText } from "./expression";
import { getBalancePreset } from "./presets";

/** A successful balance query. */
export interface BalanceResult {
	queryType?: "balance" | "usage" | "cost";
	remaining?: number;
	total?: number;
	used?: number;
	unit?: string;
	planName?: string;
	extra?: string;
	/** The URL that produced this result, shown in the tooltip. */
	requestUrl: string;
	/** Epoch milliseconds of the successful query. */
	checkedAt: number;
}

/**
 * A failed balance query.
 *
 * `transient` separates "the network hiccuped" from "this will keep failing".
 * A transient failure may leave the last known value on screen; a deterministic
 * one must not, because the credentials or configuration behind it changed.
 */
export interface BalanceFailure {
	message: string;
	transient: boolean;
	requestUrl?: string;
	checkedAt: number;
}

export type BalanceOutcome = { ok: true; result: BalanceResult } | { ok: false; failure: BalanceFailure };

export const DEFAULT_BALANCE_TIMEOUT_MS = 10_000;
/** Reject absurd payloads instead of buffering them. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** Fill in missing fields from the selected preset so a half-filled form still runs. */
export function resolveBalanceConfig(balance: ProviderBalanceConfig): ProviderBalanceConfig {
	const preset = getBalancePreset(balance.preset);
	if (!preset) {
		return balance;
	}
	return {
		...preset.config,
		...balance,
		headers: { ...preset.config.headers, ...balance.headers },
		extract: { ...preset.config.extract, ...balance.extract },
	};
}

function stripTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function resolvePlaceholders(
	template: string,
	baseUrl: string,
	apiKey: string,
	windowDays = 7,
	timeFormat: "iso" | "unix" = "iso"
): string {
	const normalizedBase = stripTrailingSlash(baseUrl.trim());
	let origin = "";
	try {
		const parsed = new URL(normalizedBase);
		origin = `${parsed.protocol}//${parsed.host}`;
	} catch {
		origin = "";
	}
	const end = new Date();
	const start = new Date(end.getTime() - Math.max(1, windowDays) * 24 * 60 * 60 * 1000);
	const formatTime = (value: Date) => (timeFormat === "unix" ? String(Math.floor(value.getTime() / 1000)) : value.toISOString());
	return template
		.replaceAll("{{baseUrl}}", normalizedBase)
		.replaceAll("{{origin}}", origin)
		.replaceAll("{{apiKey}}", apiKey)
		.replaceAll("{{startTime}}", formatTime(start))
		.replaceAll("{{endTime}}", formatTime(end))
		.replaceAll("{{startTimeUnix}}", String(Math.floor(start.getTime() / 1000)))
		.replaceAll("{{endTimeUnix}}", String(Math.floor(end.getTime() / 1000)));
}

/**
 * Resolve the request URL.
 *
 * A relative path is appended to the provider Base URL, so `/user/balance`
 * against `https://api.deepseek.com` queries
 * `https://api.deepseek.com/user/balance`.
 */
export function resolveBalanceUrl(
	rawUrl: string | undefined,
	baseUrl: string | undefined,
	apiKey: string,
	windowDays = 7,
	timeFormat: "iso" | "unix" = "iso"
): string | undefined {
	const template = (rawUrl ?? "").trim();
	if (!template) {
		return undefined;
	}
	const normalizedBase = stripTrailingSlash((baseUrl ?? "").trim());
	const replaced = resolvePlaceholders(template, normalizedBase, apiKey, windowDays, timeFormat);
	let candidate: string;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(replaced)) {
		// An absolute endpoint stands on its own: a billing host does not have to be
		// the provider's inference host, so a missing Base URL is not an error here.
		candidate = replaced;
	} else if (!normalizedBase) {
		return undefined;
	} else if (replaced.startsWith("/")) {
		candidate = `${normalizedBase}${replaced}`;
	} else {
		candidate = `${normalizedBase}/${replaced}`;
	}
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return undefined;
	}
	return parsed.toString();
}

function buildHeaders(config: ProviderBalanceConfig, baseUrl: string, apiKey: string): Record<string, string> {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"User-Agent": VersionManager.getUserAgent(),
	};
	const auth = config.auth ?? "bearer";
	if (apiKey && auth === "bearer") {
		headers.Authorization = `Bearer ${apiKey}`;
	} else if (apiKey && auth === "x-api-key") {
		headers["x-api-key"] = apiKey;
	}
	for (const [name, value] of Object.entries(config.headers ?? {})) {
		headers[name] = resolvePlaceholders(value, baseUrl, apiKey);
	}
	return headers;
}

function isTransientStatus(status: number): boolean {
	return status >= 500 || status === 429 || status === 408;
}

function describeExpressionError(error: unknown): string {
	if (error instanceof BalanceExpressionError) {
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function responseBuckets(payload: unknown): readonly Record<string, unknown>[] {
	if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
		return [];
	}
	return (payload as { data: unknown[] }).data.filter(
		(value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
	);
}

function aggregateOrganizationReport(adapter: ProviderBalanceConfig["adapter"], payload: unknown): BalanceResult | undefined {
	const buckets = responseBuckets(payload);
	if (!buckets.length || !adapter) {
		return undefined;
	}
	let total = 0;
	let found = false;
	for (const bucket of buckets) {
		const results = Array.isArray(bucket.results) ? bucket.results : [bucket];
		for (const entry of results) {
			if (!entry || typeof entry !== "object") {
				continue;
			}
			const record = entry as Record<string, unknown>;
			let value: number | undefined;
			switch (adapter) {
				case "openai-usage":
					value = (asFiniteNumber(record.input_tokens) ?? 0) + (asFiniteNumber(record.output_tokens) ?? 0);
					break;
				case "openai-cost": {
					const amount = record.amount && typeof record.amount === "object" ? (record.amount as Record<string, unknown>).value : undefined;
					value = asFiniteNumber(amount);
					break;
				}
				case "anthropic-usage":
					value =
						(asFiniteNumber(record.uncached_input_tokens) ?? 0) +
						(asFiniteNumber(record.cached_input_tokens) ?? 0) +
						(asFiniteNumber(record.cache_creation_input_tokens) ?? 0) +
						(asFiniteNumber(record.output_tokens) ?? 0);
					break;
				case "anthropic-cost":
					value = (asFiniteNumber(record.cost_cents) ?? 0) / 100;
					break;
			}
			if (value !== undefined) {
				total += value;
				found = true;
			}
		}
	}
	if (!found) {
		return undefined;
	}
	return {
		remaining: total,
		unit: adapter.endsWith("cost") ? "USD" : "tokens",
		planName: adapter.startsWith("openai") ? "OpenAI organization" : "Anthropic organization",
		requestUrl: "",
		checkedAt: Date.now(),
	};
}

/**
 * Run one balance query.
 *
 * Never throws: transport, HTTP, and parsing problems are all reported as a
 * `BalanceFailure` so the caller can decide what to keep on screen.
 */
export async function queryProviderBalance(options: {
	config: ProviderBalanceConfig;
	baseUrl: string | undefined;
	apiKey: string;
	/** Overrides the configured timeout, used by the interactive Test button. */
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<BalanceOutcome> {
	const { config, baseUrl, apiKey } = options;
	const resolved = resolveBalanceConfig(config);
	if (resolved.credential === "admin" && !apiKey.trim()) {
		return {
			ok: false,
			failure: {
				message: "This organization report requires an Admin API key. Add one in the query settings.",
				transient: false,
				checkedAt: Date.now(),
			},
		};
	}
	const requestUrl = resolveBalanceUrl(resolved.url, baseUrl, apiKey, resolved.windowDays, resolved.timeFormat);
	const checkedAt = Date.now();

	if (!requestUrl) {
		return {
			ok: false,
			failure: {
				message: resolved.url
					? "The balance URL could not be resolved. Check the provider Base URL and the URL template."
					: "No balance URL is configured.",
				transient: false,
				checkedAt,
			},
		};
	}

	const extract = resolved.extract;
	if (!extract?.remaining) {
		return {
			ok: false,
			failure: {
				message: "No extractor is configured for the remaining balance.",
				transient: false,
				requestUrl,
				checkedAt,
			},
		};
	}

	const timeoutMs = options.timeoutMs ?? resolved.timeoutMs ?? DEFAULT_BALANCE_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const doFetch = options.fetchImpl ?? fetch;

	let response: Response;
	let body: string;
	try {
		response = await doFetch(requestUrl, {
			method: (resolved.method ?? "GET").toUpperCase(),
			headers: buildHeaders(resolved, baseUrl ?? "", apiKey),
			signal: controller.signal,
		});
		body = await response.text();
	} catch (error) {
		const aborted = error instanceof Error && error.name === "AbortError";
		return {
			ok: false,
			failure: {
				message: aborted
					? `The balance query timed out after ${timeoutMs} ms.`
					: `The balance request failed: ${error instanceof Error ? error.message : String(error)}`,
				transient: true,
				requestUrl,
				checkedAt,
			},
		};
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		const detail = body.trim().slice(0, 300);
		return {
			ok: false,
			failure: {
				message: `The balance endpoint answered HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
				transient: isTransientStatus(response.status),
				requestUrl,
				checkedAt,
			},
		};
	}

	if (body.length > MAX_RESPONSE_BYTES) {
		return {
			ok: false,
			failure: {
				message: "The balance response is unexpectedly large and was ignored.",
				transient: false,
				requestUrl,
				checkedAt,
			},
		};
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return {
			ok: false,
			failure: {
				message: "The balance endpoint did not return JSON.",
				transient: false,
				requestUrl,
				checkedAt,
			},
		};
	}

	try {
		const aggregate = aggregateOrganizationReport(resolved.adapter, payload);
		if (aggregate) {
			return { ok: true, result: { ...aggregate, requestUrl, checkedAt } };
		}
		const remaining = evaluateBalanceNumber(extract.remaining, payload);
		if (remaining === undefined) {
			return {
				ok: false,
				failure: {
					message: `The response has no usable value at "${extract.remaining}".`,
					transient: false,
					requestUrl,
					checkedAt,
				},
			};
		}
				const result: BalanceResult = {
					queryType: resolved.queryType,
			remaining,
			requestUrl,
			checkedAt,
		};
		if (extract.total) {
			result.total = evaluateBalanceNumber(extract.total, payload);
		}
		if (extract.used) {
			result.used = evaluateBalanceNumber(extract.used, payload);
		}
		if (extract.unit) {
			result.unit = evaluateBalanceText(extract.unit, payload);
		}
		if (extract.planName) {
			result.planName = evaluateBalanceText(extract.planName, payload);
		}
		if (extract.extra) {
			result.extra = evaluateBalanceText(extract.extra, payload);
		}
		return { ok: true, result };
	} catch (error) {
		return {
			ok: false,
			failure: {
				message: `The extractor failed: ${describeExpressionError(error)}`,
				transient: false,
				requestUrl,
				checkedAt,
			},
		};
	}
}

/** Read the balance configuration of a provider record. */
export function getProviderBalanceConfig(
	models: readonly HFModelItem[],
	provider: string
): ProviderBalanceConfig | undefined {
	const record = models.find((model) => model.providerConfig === true && model.owned_by === provider);
	return record?.balance;
}
