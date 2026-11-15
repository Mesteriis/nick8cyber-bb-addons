/**
 * Звонок по сообщению (контракт §12.13, ADR-0026): валидация полей hello,
 * поиск предмета по seq события, соседи предмета и блок предмета для инструкции.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { fetchThreadMessages, formatMessageTime, formatSingleMessage, type ThreadMessage } from "./thread-messages.js";

/**
 * Проверки полей сообщения в hello (§12.13 «Вход»): нарушение — кадр error bad_hello.
 * Возвращает текст ошибки или null, когда поля согласованы.
 */
export function messageHelloError(frame: {
  threadId?: string;
  projectId?: string;
  messageSeq?: number;
  selectedText?: string;
}): string | null {
  if (frame.threadId && frame.projectId) return "в одном hello не бывает и threadId, и projectId";
  if ((frame.messageSeq !== undefined || frame.selectedText !== undefined) && !frame.threadId) {
    return "messageSeq и selectedText действительны только со звонком по треду (threadId)";
  }
  if (frame.selectedText !== undefined && frame.messageSeq === undefined) {
    return "selectedText действителен только вместе с messageSeq";
  }
  return null;
}

/**
 * Поиск предмета в обработчике hello до startCall (§12.13): собирает сообщения §12.2
 * и ищет точное совпадение messageSeq → seq события-источника. Запасного поиска нет.
 */
export async function resolveTargetMessage(
  sdk: BbPluginApi["sdk"],
  threadId: string,
  messageSeq: number,
): Promise<ThreadMessage | undefined> {
  const messages = await fetchThreadMessages(sdk, threadId);
  return messages.find((m) => m.seq === messageSeq);
}

/**
 * Соседи предмета в том же блоке (§12.13 «Контекст»):
 * - предмет — сообщение агента: ближайшее предыдущее сообщение владельца, если есть;
 * - предмет — сообщение владельца: следующие сообщения агента до следующего владельца, ≤ 3;
 * - соседей нет — пустой массив (пометку не писать).
 */
export function messageNeighbors(messages: ThreadMessage[], target: ThreadMessage): ThreadMessage[] {
  const at = messages.findIndex((m) => m.seq === target.seq);
  if (at < 0) return [];
  if (messages[at].role === "agent") {
    for (let i = at - 1; i >= 0; i--) {
      if (messages[i].role === "owner") return [messages[i]];
    }
    return [];
  }
  const out: ThreadMessage[] = [];
  for (let i = at + 1; i < messages.length && out.length < 3; i++) {
    if (messages[i].role === "owner") break;
    out.push(messages[i]);
  }
  return out;
}

/**
 * Блок предмета до блока сообщений (§12.13 «Контекст»), всегда целиком:
 * без выделения — «СООБЩЕНИЕ №n (роль, время), ПО КОТОРОМУ ЗВОНЯТ:» + текст;
 * с выделением — «ВЫДЕЛЕННЫЙ ФРАГМЕНТ…» + фрагмент, затем «СООБЩЕНИЕ №n ЦЕЛИКОМ:» + текст.
 * После — соседи с пометкой «КОНТЕКСТ ВОКРУГ СООБЩЕНИЯ №n:» (нет соседей — без пометки).
 */
export function formatMessageSubjectBlock(target: ThreadMessage, neighbors: ThreadMessage[], selectedText?: string): string {
  const roleStr = target.role === "owner" ? "Владелец" : "Агент";
  const timeStr = formatMessageTime(target.createdAt);
  const roleTime = timeStr ? `${roleStr}, ${timeStr}` : roleStr;
  const parts: string[] = [];
  if (selectedText) {
    parts.push(`ВЫДЕЛЕННЫЙ ФРАГМЕНТ СООБЩЕНИЯ №${target.number}:\n${selectedText}`);
    parts.push(`СООБЩЕНИЕ №${target.number} ЦЕЛИКОМ:\n${target.text}`);
  } else {
    parts.push(`СООБЩЕНИЕ №${target.number} (${roleTime}), ПО КОТОРОМУ ЗВОНЯТ:\n${target.text}`);
  }
  if (neighbors.length > 0) {
    parts.push(`КОНТЕКСТ ВОКРУГ СООБЩЕНИЯ №${target.number}:\n${neighbors.map(formatSingleMessage).join("\n\n")}`);
  }
  return parts.join("\n\n");
}
