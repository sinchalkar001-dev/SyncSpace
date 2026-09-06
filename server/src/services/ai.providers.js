import { env } from '../config/env.js'

/**
 * Which model service to call, and how to talk to it.
 *
 * Two vendors, one request shape on our side. The part that matters is not
 * that both are supported — it is that both are made to answer in the *same*
 * structured way, through their function-calling APIs, so everything
 * downstream stays a single code path. Asking politely for JSON and parsing
 * whatever comes back would have been less code here and a great deal more
 * everywhere else, because a model that wraps its answer in a code fence once
 * a day is a failed generation somebody paid for.
 *
 * The provider is inferred from the key rather than configured beside it. A
 * key and a provider that disagree is an ordinary mistake with an unhelpful
 * symptom — a 401 from a service the key was never for — and the key already
 * says which service issued it.
 */

/**
 * Which vendor issued this key.
 *
 * Anthropic's begin `sk-ant-`. Google has two formats in circulation: the long
 * standing `AIza…`, and `AQ.…`, which is what AI Studio hands out now — a key
 * created today is the second kind, and recognising only the first turns a
 * perfectly good key into "unrecognised" the moment somebody rotates one.
 */
export function providerFor(key) {
  if (!key) return null
  if (key.startsWith('sk-ant-')) return 'anthropic'
  if (key.startsWith('AIza') || key.startsWith('AQ.')) return 'google'
  return null
}

/**
 * The key and provider this deployment is configured with.
 *
 * `AI_PROVIDER` wins when set, for a gateway or a proxy whose keys look like
 * neither. Otherwise the shape of the key decides, and a key whose shape is
 * unrecognised is reported rather than guessed at.
 */
export function resolveProvider() {
  const key = env.ANTHROPIC_API_KEY ?? env.GOOGLE_API_KEY ?? null
  if (!key) return { key: null, provider: null }

  const provider = env.AI_PROVIDER ?? providerFor(key)
  return { key, provider }
}

/**
 * JSON Schema as Google's function declarations want it.
 *
 * Gemini takes a subset of OpenAPI rather than JSON Schema: type names are
 * upper case, and unknown keywords are rejected outright rather than ignored.
 * Converting here keeps one schema in ai.service.js as the single description
 * of the answer we expect, instead of two that drift.
 */
export function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema

  const converted = {}

  if (schema.type) converted.type = String(schema.type).toUpperCase()
  if (schema.description) converted.description = schema.description
  if (schema.enum) converted.enum = schema.enum
  if (schema.required) converted.required = schema.required

  if (schema.properties) {
    converted.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => [name, toGeminiSchema(value)])
    )
  }

  if (schema.items) converted.items = toGeminiSchema(schema.items)

  return converted
}

const ANTHROPIC = {
  name: 'anthropic',
  defaultBaseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-sonnet-5',

  request({ baseUrl, key, model, system, prompt, tool, maxTokens }) {
    return {
      url: baseUrl + '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: {
        model,
        max_tokens: maxTokens,
        system,
        tools: [tool],
        // Forced, so the answer arrives as arguments rather than as prose
        // that has to be dug out of a paragraph.
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: prompt }],
      },
    }
  },

  parse(payload, toolName) {
    const block = payload?.content?.find(
      (part) => part?.type === 'tool_use' && part?.name === toolName
    )
    return {
      input: block?.input ?? null,
      model: payload?.model ?? null,
      stopReason: payload?.stop_reason ?? null,
      usage: {
        inputTokens: payload?.usage?.input_tokens ?? null,
        outputTokens: payload?.usage?.output_tokens ?? null,
      },
    }
  },
}

const GOOGLE = {
  name: 'google',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  /**
   * The older 2.5 names are still listed by the models endpoint but are
   * closed to new keys, which answers a 404 that reads like the model does
   * not exist. This is what Google points new projects at.
   */
  defaultModel: 'gemini-3.6-flash',

  request({ baseUrl, key, model, system, prompt, tool, maxTokens }) {
    return {
      /**
       * The key travels as a header, not as `?key=`. Both are accepted; a
       * query string is the one that ends up in proxy logs and error
       * messages, and this one is a live credential.
       */
      url: baseUrl + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': key,
      },
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: tool.name,
                description: tool.description,
                parameters: toGeminiSchema(tool.input_schema),
              },
            ],
          },
        ],
        // ANY with a single allowed name is Gemini's equivalent of forcing
        // one tool: it must call it, and it has only this one to call.
        toolConfig: {
          functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tool.name] },
        },
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.2 },
      },
    }
  },

  parse(payload, toolName) {
    const candidate = payload?.candidates?.[0]
    const call = candidate?.content?.parts?.find(
      (part) => part?.functionCall?.name === toolName
    )?.functionCall

    return {
      input: call?.args ?? null,
      model: payload?.modelVersion ?? null,
      // Gemini says MAX_TOKENS where Anthropic says max_tokens; normalised so
      // the caller can explain a cut-off answer without knowing which vendor
      // it was talking to.
      stopReason: candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : candidate?.finishReason,
      usage: {
        inputTokens: payload?.usageMetadata?.promptTokenCount ?? null,
        outputTokens: payload?.usageMetadata?.candidatesTokenCount ?? null,
      },
    }
  },
}

const PROVIDERS = { anthropic: ANTHROPIC, google: GOOGLE }

export const providerNamed = (name) => PROVIDERS[name] ?? null
