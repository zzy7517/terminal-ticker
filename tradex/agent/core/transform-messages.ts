/**
 * core/transform-messages.ts — Cross-cutting message transforms.
 *
 * Modeled after pi-mono's packages/ai/src/providers/transform-messages.ts but
 * trimmed to the transforms tradex actually uses today:
 *   - downgradeUnsupportedImages: replace ImageContent with a placeholder
 *     when the target model does not list "image" in its inputs.
 *
 * Run this in the StreamFn just before handing the context to the provider so
 * every provider gets a consistent, capability-aware view of the messages.
 */

import type {
  AgentMessage,
  AgentModelDescriptor,
  ImageContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "./types.js";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

/**
 * Replace every ImageContent with a TextContent placeholder. Adjacent images
 * collapse into a single placeholder so the prompt does not get spammed with
 * repeated lines.
 */
function replaceImagesWithPlaceholder(
  content: (TextContent | ImageContent)[],
  placeholder: string,
): TextContent[] {
  const result: TextContent[] = [];
  let previousWasPlaceholder = false;
  for (const block of content) {
    if (block.type === "image") {
      if (!previousWasPlaceholder) {
        result.push({ type: "text", text: placeholder });
      }
      previousWasPlaceholder = true;
      continue;
    }
    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }
  return result;
}

/**
 * Returns true when the model declares image input support.
 * Defaults to false when `inputs` is undefined, matching pi's behaviour
 * where models opt in to image support explicitly.
 */
export function modelSupportsImages(model: AgentModelDescriptor): boolean {
  return Array.isArray(model.inputs) && model.inputs.includes("image");
}

/**
 * Downgrade ImageContent for non-vision models. User messages with string
 * content pass through untouched. Assistant and Custom messages are returned
 * as-is.
 */
export function transformMessages(
  messages: AgentMessage[],
  model: AgentModelDescriptor,
): AgentMessage[] {
  if (modelSupportsImages(model)) return messages;

  return messages.map((msg) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const downgraded = replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER);
      const next: UserMessage = { ...msg, content: downgraded };
      return next;
    }
    if (msg.role === "toolResult") {
      const downgraded = replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER);
      const next: ToolResultMessage = { ...msg, content: downgraded };
      return next;
    }
    return msg;
  });
}
