/**
 * T007 — gateway-routed visionChat helper.
 *
 * Pins:
 *   1. toModelMessages converts an image ChatBlock into an AI SDK image data-URL part.
 *   2. visionChat builds the correct ChatMessage content (image blocks + text block)
 *      and calls chat() — verified via __setChatTransportForTests without a network call.
 *   3. visionChat returns the assistant text from the ChatResult.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  toModelMessages,
  __setChatTransportForTests,
  resetGateway,
  type ChatMessage,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { visionChat } from '../src/core/ai/vision.ts';

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

// ---------------------------------------------------------------------------
// toModelMessages — image block mapping
// ---------------------------------------------------------------------------

describe('toModelMessages — image ChatBlock', () => {
  test('image block maps to AI SDK image data-URL part', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image', image: { data: 'abc123', mime: 'image/png' } },
          { type: 'text', text: 'What is in this image?' },
        ],
      },
    ];
    const out = toModelMessages(msgs) as any[];
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    const parts = out[0].content;
    expect(parts[0]).toEqual({ type: 'image', image: 'data:image/png;base64,abc123' });
    expect(parts[1]).toEqual({ type: 'text', text: 'What is in this image?' });
  });

  test('image block with jpeg mime produces correct data URL', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'image', image: { data: 'xyz789', mime: 'image/jpeg' } }],
      },
    ];
    const out = toModelMessages(msgs) as any[];
    expect(out[0].content[0]).toEqual({ type: 'image', image: 'data:image/jpeg;base64,xyz789' });
  });
});

// ---------------------------------------------------------------------------
// visionChat — message construction + transport
// ---------------------------------------------------------------------------

describe('visionChat', () => {
  test('builds user message with image blocks followed by text block, returns assistant text', async () => {
    let capturedOpts: any = null;

    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      capturedOpts = opts;
      return {
        text: 'A cat sitting on a mat.',
        blocks: [{ type: 'text', text: 'A cat sitting on a mat.' }],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      };
    });

    const result = await visionChat({
      images: [{ data: 'imgdata1', mime: 'image/png' }],
      prompt: 'Describe the image.',
    });

    expect(result).toBe('A cat sitting on a mat.');

    // Verify the ChatMessage structure passed to chat()
    expect(capturedOpts).not.toBeNull();
    expect(capturedOpts.messages).toHaveLength(1);
    const msg = capturedOpts.messages[0];
    expect(msg.role).toBe('user');
    expect(Array.isArray(msg.content)).toBe(true);

    // Image blocks come first, then the text prompt
    expect(msg.content[0]).toEqual({ type: 'image', image: { data: 'imgdata1', mime: 'image/png' } });
    expect(msg.content[1]).toEqual({ type: 'text', text: 'Describe the image.' });
  });

  test('multiple images produce multiple image blocks before the text block', async () => {
    let capturedOpts: any = null;

    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      capturedOpts = opts;
      return {
        text: 'Two images.',
        blocks: [{ type: 'text', text: 'Two images.' }],
        stopReason: 'end',
        usage: { input_tokens: 20, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      };
    });

    await visionChat({
      images: [
        { data: 'img1', mime: 'image/png' },
        { data: 'img2', mime: 'image/jpeg' },
      ],
      prompt: 'Compare the images.',
    });

    const msg = capturedOpts.messages[0];
    expect(msg.content).toHaveLength(3); // 2 images + 1 text
    expect(msg.content[0]).toEqual({ type: 'image', image: { data: 'img1', mime: 'image/png' } });
    expect(msg.content[1]).toEqual({ type: 'image', image: { data: 'img2', mime: 'image/jpeg' } });
    expect(msg.content[2]).toEqual({ type: 'text', text: 'Compare the images.' });
  });

  test('system and model opts are forwarded to chat()', async () => {
    let capturedOpts: any = null;

    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      capturedOpts = opts;
      return {
        text: 'ok',
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      };
    });

    await visionChat({
      images: [{ data: 'x', mime: 'image/png' }],
      prompt: 'Hello',
      system: 'You are a vision assistant.',
      model: 'anthropic:claude-opus-4-7',
      maxTokens: 512,
    });

    expect(capturedOpts.system).toBe('You are a vision assistant.');
    expect(capturedOpts.model).toBe('anthropic:claude-opus-4-7');
    expect(capturedOpts.maxTokens).toBe(512);
  });
});
