// Client for Opus's offline AI. The model runs as a local server (llama.cpp)
// that the app sets up once; here we manage setup and stream chat replies.

import { invoke } from "@tauri-apps/api/core";
import { isDesktop } from "./platform.ts";

export interface AiInfo {
  has_server: boolean;
  model_present: boolean;
  model_name: string;
  model_size_mb: number;
  running: boolean;
  port: number;
}

export interface SetupProgress {
  stage: "engine" | "model" | "extract" | "done";
  received: number;
  total: number;
  note: string;
}

export async function aiInfo(): Promise<AiInfo> {
  if (!isDesktop) return { has_server: false, model_present: false, model_name: "Qwen2.5 7B Instruct", model_size_mb: 4700, running: false, port: 0 };
  return invoke<AiInfo>("ai_info");
}

/** Downloads the engine + model if needed, reporting progress. */
export async function setupAI(onProgress: (p: SetupProgress) => void): Promise<void> {
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<SetupProgress>("ai-setup", (e) => onProgress(e.payload));
  try {
    await invoke("ai_setup");
  } finally {
    un();
  }
}

export async function cancelSetup(): Promise<void> {
  await invoke("ai_cancel_setup").catch(() => {});
}

/** Starts the model server (loads the model) and returns its port. */
export async function startServer(): Promise<number> {
  return invoke<number>("ai_start");
}

export async function stopServer(): Promise<void> {
  await invoke("ai_stop").catch(() => {});
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  onToken?: (text: string) => void;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Streams a chat completion from an OpenAI-compatible server at `baseUrl`.
 * Returns the full text. Calls onToken as pieces arrive.
 */
export async function streamChatAt(baseUrl: string, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "opus-local",
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.4,
      max_tokens: opts.maxTokens ?? 1024,
      cache_prompt: true,
    }),
    signal: opts.signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`The AI model didn't respond (${resp.status}).`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const json = JSON.parse(data);
        const piece = json.choices?.[0]?.delta?.content ?? "";
        if (piece) {
          full += piece;
          opts.onToken?.(piece);
        }
      } catch {
        /* ignore keep-alive / partial lines */
      }
    }
  }
  return full;
}

export async function streamChat(port: number, messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  return streamChatAt(`http://127.0.0.1:${port}`, messages, opts);
}

// ---------- prompt helpers ----------

/** Rough character budget for the document so prompt + reply fit the context. */
const DOC_BUDGET = 22000;

export function clampDoc(text: string): { text: string; truncated: boolean } {
  const clean = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (clean.length <= DOC_BUDGET) return { text: clean, truncated: false };
  return { text: clean.slice(0, DOC_BUDGET), truncated: true };
}

export function chatMessages(docText: string, question: string, history: ChatMessage[]): ChatMessage[] {
  const { text, truncated } = clampDoc(docText);
  const system: ChatMessage = {
    role: "system",
    content:
      "You are Opus's assistant, answering questions about the user's PDF. " +
      "Use the document text below as your only source. If the answer isn't in it, say so plainly. " +
      "Be concise and quote figures exactly." +
      (truncated ? " (Only the first part of a long document is included.)" : "") +
      `\n\n===== DOCUMENT =====\n${text}\n===== END =====`,
  };
  return [system, ...history, { role: "user", content: question }];
}

export function summarizeMessages(docText: string, style: "brief" | "bullets" | "detailed"): ChatMessage[] {
  const { text, truncated } = clampDoc(docText);
  const ask =
    style === "bullets" ? "Summarize this document as 5-8 concise bullet points."
    : style === "detailed" ? "Write a thorough summary of this document in a few short paragraphs."
    : "Summarize this document in 2-3 sentences.";
  return [
    { role: "system", content: "You summarize documents accurately and never invent facts." + (truncated ? " Only the first part of a long document is included." : "") },
    { role: "user", content: `${ask}\n\n===== DOCUMENT =====\n${text}\n===== END =====` },
  ];
}

export function rewriteMessages(text: string, instruction: string): ChatMessage[] {
  return [
    { role: "system", content: "You rewrite text as instructed and return only the rewritten text, with no preamble." },
    { role: "user", content: `${instruction}\n\n===== TEXT =====\n${text.slice(0, DOC_BUDGET)}\n===== END =====` },
  ];
}
