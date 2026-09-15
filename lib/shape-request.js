export class ValidationError extends Error {}

// Turns a client-supplied request body into the exact payload sent to Anthropic.
// Deliberately narrow: the client can send `messages` and optionally `tools`,
// nothing else. The model is pinned here, not trusted from the client, so a
// modified frontend can't quietly switch to a more expensive model on your key.
// max_tokens is capped here too, for the same reason.
export function shapeUpstreamRequest(body) {
  const { messages, tools, max_tokens } = body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ValidationError("Request body must include a non-empty 'messages' array.");
  }

  const payload = {
    model: "claude-sonnet-4-6",
    max_tokens: Math.min(Number.isFinite(Number(max_tokens)) ? Number(max_tokens) : 1000, 1000),
    messages,
  };

  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
  }

  return payload;
}
