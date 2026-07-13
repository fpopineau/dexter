/**
 * vLLM API utilities.
 *
 * vLLM serves an OpenAI-compatible API; the served model(s) are discovered
 * from GET {VLLM_BASE_URL}/models (typically a single model per server).
 */

interface OpenAiModel {
  id: string;
}

interface OpenAiModelsResponse {
  data: OpenAiModel[];
}

/**
 * Fetches the models served by the local vLLM endpoint.
 * Returns [] when vLLM is not running or unreachable.
 */
export async function getVllmModels(): Promise<string[]> {
  const baseUrl = process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000/v1';

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/models`);

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as OpenAiModelsResponse;
    return (data?.data ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === 'string');
  } catch {
    // vLLM not running or unreachable
    return [];
  }
}
