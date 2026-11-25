/**
 * Built-in provider presets.
 *
 * A preset is nothing more than a convenient starting template: name, base URL
 * and (optionally) a suggested model. Nothing in the extension is gated on this
 * list. Any OpenAI-compatible endpoint can be configured manually, and every
 * field of a preset (base URL, model, key, parameters) stays editable.
 *
 * `suggestedModel` is intentionally empty for providers whose model catalogue
 * changes frequently: the user types whatever model their account can access.
 */

export const PRESETS = [
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    suggestedModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    modelHint: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    tagline: 'Nemotron, Mistral and more on NVIDIA-hosted NIM',
    accent: '#76b900',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    suggestedModel: 'llama-3.3-70b-versatile',
    modelHint: 'llama-3.3-70b-versatile',
    tagline: 'Very low latency LPU inference',
    accent: '#f55036',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    suggestedModel: 'gpt-4o-mini',
    modelHint: 'gpt-4o-mini',
    tagline: 'GPT models and o-series reasoning models',
    accent: '#10a37f',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    suggestedModel: '',
    modelHint: 'meta-llama/llama-3.3-70b-instruct',
    tagline: 'One key for hundreds of hosted models',
    accent: '#8b5cf6',
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    suggestedModel: '',
    modelHint: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    tagline: 'Open-source models on Together',
    accent: '#0f6fff',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    suggestedModel: '',
    modelHint: 'deepseek-chat',
    tagline: 'DeepSeek chat and reasoning models',
    accent: '#4d6bfe',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    suggestedModel: '',
    modelHint: 'llama-3.3-70b',
    tagline: 'Wafer-scale inference',
    accent: '#ff6b35',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    suggestedModel: '',
    modelHint: 'mistral-large-latest',
    tagline: 'Mistral AI hosted models',
    accent: '#ff7000',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    suggestedModel: '',
    modelHint: 'llama3.2',
    tagline: 'Local models, no API key required',
    accent: '#9aa3b2',
    local: true,
  },
];

const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

export function getPreset(id) {
  if (typeof id !== 'string') return null;
  return BY_ID.get(id) || null;
}

/** Hosts we can recognise without treating a config as a custom endpoint. */
const PRESET_HOSTS = new Set(
  PRESETS.map((p) => {
    try {
      return new URL(p.baseUrl).host.toLowerCase();
    } catch {
      return '';
    }
  }).filter(Boolean),
);

export function isKnownPresetHost(hostname) {
  if (!hostname) return false;
  return PRESET_HOSTS.has(String(hostname).toLowerCase());
}

/** Name used when the user adds a fully custom endpoint. */
export const CUSTOM_PROVIDER_DEFAULT_NAME = 'Custom provider';
