import fs from 'node:fs';
import path from 'node:path';
import { PuterProvider } from './puter.js';
import { GeminiProvider, GEMINI_DEFAULT_MODEL } from './gemini.js';
import { OpenAIProvider, OPENAI_DEFAULT_MODEL } from './openai.js';

// A provider exposes: name, connect(), listModels(), chat({ model, messages, tools, signal }).
// Adding another backend later means adding one entry here; the agent never imports a provider directly.
const PROVIDERS = {
  puter: (options) => new PuterProvider(options),
  gemini: (options) => new GeminiProvider(options),
  openai: (options) => new OpenAIProvider(options),
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS);
const DEFAULT_MODELS = { gemini: GEMINI_DEFAULT_MODEL, openai: OPENAI_DEFAULT_MODEL };

export function createProvider(name, options = {}) {
  const factory = PROVIDERS[name];
  if (!factory) throw new Error(`Unknown provider "${name}". Available: ${PROVIDER_NAMES.join(', ')}`);
  return factory(options);
}

export function readConnectFile(rootDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(rootDir, 'config', 'connect.json'), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/**
 * Which provider and model to start with.
 * Provider: AGENT_PROVIDER env > config/connect.json > "puter".
 * Model:    --model flag > connect.json model of that provider > provider default > settings.model.
 */
export function resolveProvider({ rootDir, env = process.env, cliModel, settingsModel }) {
  const connect = readConnectFile(rootDir);
  const wanted = (env.AGENT_PROVIDER || connect.provider || 'puter').toLowerCase();
  const name = PROVIDERS[wanted] ? wanted : 'puter';
  const model = cliModel || connect.models?.[name]?.model || DEFAULT_MODELS[name] || settingsModel;
  return { name, model, thinking: connect.models?.[name]?.thinking, reasoningMode: connect.models?.[name]?.reasoningMode, unknown: PROVIDERS[wanted] ? null : wanted };
}
