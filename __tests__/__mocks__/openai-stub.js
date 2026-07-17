/**
 * openai-stub.js — drop-in mock for the OpenAI SDK during tests.
 *
 * Stubs:
 *   client.chat.completions.create()  — used by generateAffirmation, chronicle, milestone narrative, gender detect
 *   client.audio.transcriptions.create() — used by transcribeAudio
 *
 * Behavior is intentionally generic; tests that need richer responses can
 * mutate `_state.responses`. Tests that need OpenAI to FAIL set `_state.failNext = true`.
 *
 * Wired via jest.config.js → moduleNameMapper:
 *   '^openai$': '<rootDir>/__tests__/__mocks__/openai-stub.js'
 */

const DEFAULT_CHAT = 'I am finishing the prototype because it supports my family. When it gets difficult, I remember why I began.';
const _state = {
  chatCalls: 0,
  transcriptionCalls: 0,
  failNext: false,
  responses: {
    chat: DEFAULT_CHAT,
    transcription: 'I want to be more present and grow my business.',
  },
};

class MockOpenAIError extends Error {
  constructor(msg, status = 500) {
    super(msg);
    this.status = status;
  }
}

class OpenAIStub {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey;
    this.chat = {
      completions: {
        create: async (params) => {
          _state.chatCalls += 1;
          if (_state.failNext) {
            _state.failNext = false;
            throw new MockOpenAIError('mock chat completion failure', 503);
          }
          let content = _state.responses.chat;
          if (content === DEFAULT_CHAT) {
            try {
              const userMessage = [...(params?.messages || [])].reverse().find((item) => item.role === 'user' && String(item.content || '').includes('first_message_input'));
              const parsed = userMessage ? JSON.parse(userMessage.content) : null;
              const semantic = parsed?.semanticContext;
              if (semantic?.goal && semantic?.purpose && semantic?.reconnectionAnchor) {
                content = `I hold ${semantic.goal}. ${semantic.purpose}. When it gets hard, ${semantic.reconnectionAnchor}.`;
              }
            } catch (_) {}
          }
          return {
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: params?.model || 'gpt-4o-mini',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
          };
        },
      },
    };
    this.audio = {
      transcriptions: {
        create: async () => {
          _state.transcriptionCalls += 1;
          if (_state.failNext) {
            _state.failNext = false;
            throw new MockOpenAIError('mock transcription failure', 503);
          }
          return { text: _state.responses.transcription };
        },
      },
    };
  }
}

OpenAIStub._state = _state;
OpenAIStub._reset = () => {
  _state.chatCalls = 0;
  _state.transcriptionCalls = 0;
  _state.failNext = false;
  _state.responses.chat = DEFAULT_CHAT;
  _state.responses.transcription = 'I want to be more present and grow my business.';
};

module.exports = OpenAIStub;
module.exports.default = OpenAIStub;
module.exports.OpenAI = OpenAIStub;
