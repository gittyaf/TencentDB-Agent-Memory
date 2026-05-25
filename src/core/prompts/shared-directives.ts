/**
 * Shared prompt directives used across L1/L2/L3 extraction prompts.
 *
 * Centralised here so language-matching behaviour is consistent and
 * a single edit propagates to all pipeline stages.
 */

/**
 * Appended to every extraction/generation system prompt to ensure
 * the LLM outputs in the same language as the user's conversation.
 *
 * Background: The hy3-preview-ioa model defaults to Chinese output
 * when the system prompt is in Chinese (which ours are — written by
 * the Tencent team). This directive overrides that default for
 * non-Chinese conversations.
 */
export const MATCH_USER_LANGUAGE_DIRECTIVE = `
IMPORTANT: All output content MUST be in the SAME LANGUAGE as the user's conversation messages. If the conversation is in English, output entirely in English. If in Chinese, output in Chinese. Match the user's language exactly.`;
