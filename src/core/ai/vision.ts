/**
 * Gateway-routed vision chat helper (T007).
 *
 * Sends one or more images plus a text prompt to a vision-capable model via
 * gateway.chat(). Routes through chat() exclusively — no ad-hoc provider SDK
 * calls at call sites.
 *
 * The image variant added to ChatBlock carries { data: string; mime: string }
 * (base64 data + MIME type). toModelMessages() in gateway.ts converts it to
 * the AI SDK image data-URL part: `data:${mime};base64,${data}`.
 *
 * Remote/SSRF: only base64 data URLs are supported. URL-based image references
 * are intentionally out of scope to avoid SSRF surface.
 */

import { chat } from './gateway.ts';
import type { ChatBlock } from './gateway.ts';

export interface VisionChatOpts {
  /** Base64-encoded images with their MIME type. */
  images: { data: string; mime: string }[];
  /** Text prompt appended after the image blocks. */
  prompt: string;
  /** Optional system prompt. */
  system?: string;
  /** "provider:modelId" — defaults to the configured chat model. */
  model?: string;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

/**
 * Send image(s) + a prompt to a vision-capable model via gateway.chat().
 * Returns the assistant text response.
 */
export async function visionChat(opts: VisionChatOpts): Promise<string> {
  const imageBlocks: ChatBlock[] = opts.images.map((img) => ({
    type: 'image' as const,
    image: { data: img.data, mime: img.mime },
  }));

  const content: ChatBlock[] = [
    ...imageBlocks,
    { type: 'text' as const, text: opts.prompt },
  ];

  const result = await chat({
    model: opts.model,
    system: opts.system,
    maxTokens: opts.maxTokens,
    abortSignal: opts.abortSignal,
    messages: [{ role: 'user', content }],
  });

  return result.text;
}
