/**
 * Звонок по сообщению (контракт §12.13, ADR-0026): предмет по seq, блок предмета
 * с соседями, окна 10+10, инструкция messageVoiceInstruction, журнал и кадры hello.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallSession } from "../src/call-session.js";
import { CallStore } from "../src/call-store.js";
import { clientFrame, type ServerFrame } from "../src/contract.js";
import {
  formatMessageSubjectBlock,
  messageHelloError,
  messageNeighbors,
  resolveTargetMessage,
} from "../src/message-call.js";
import { formatThreadMessagesBlock, type ThreadMessage } from "../src/thread-messages.js";
import { FIRST_REPLY_RULE, MESSAGE_FIRST_REPLY_RULE, messageVoiceInstruction } from "../src/prompt.js";

const msg = (number: number, role: "owner" | "agent", text: string, seq = number): ThreadMessage => ({
  number,
  role,
  text,
  createdAt: 1700000000000 + number * 60_000,
  seq,
});

const fakeThreadsSdk = (events: Array<Record<string, unknown>>) => ({
  threads: {
    events: { list: async () => events },
  },
});

describe("кадр hello: поля сообщения (§12.13 «Вход»)", () => {
  it("messageSeq и selectedText проходят схему", () => {
    expect(clientFrame.safeParse({ type: "hello", protocol: 1, threadId: "thr_testmsg01", messageSeq: 7 }).success).toBe(true);
    expect(
      clientFrame.safeParse({ type: "hello", protocol: 1, threadId: "thr_testmsg01", messageSeq: 7, selectedText: "фрагмент" }).success,
    ).toBe(true);
  });

  it("невалидные значения ломают весь hello: seq < 1, дробное, selectedText пустой или > 4000", () => {
    const base = { type: "hello", protocol: 1, threadId: "thr_testmsg01" };
    expect(clientFrame.safeParse({ ...base, messageSeq: 0 }).success).toBe(false);
    expect(clientFrame.safeParse({ ...base, messageSeq: 1.5 }).success).toBe(false);
    expect(clientFrame.safeParse({ ...base, messageSeq: 7, selectedText: "" }).success).toBe(false);
    expect(clientFrame.safeParse({ ...base, messageSeq: 7, selectedText: "a".repeat(4001) }).success).toBe(false);
    expect(clientFrame.safeParse({ ...base, messageSeq: 7, selectedText: "a".repeat(4000) }).success).toBe(true);
  });

  it("messageHelloError: нарушения → bad_hello, согласованные поля → null", () => {
    expect(messageHelloError({ threadId: "t", projectId: "p" })).toBeTruthy();
    expect(messageHelloError({ messageSeq: 3 })).toBeTruthy();
    expect(messageHelloError({ selectedText: "x" })).toBeTruthy();
    expect(messageHelloError({ projectId: "p", messageSeq: 3 })).toBeTruthy();
    expect(messageHelloError({ threadId: "t", selectedText: "x" })).toBeTruthy();
    expect(messageHelloError({ threadId: "t", messageSeq: 3 })).toBeNull();
    expect(messageHelloError({ threadId: "t", messageSeq: 3, selectedText: "x" })).toBeNull();
    expect(messageHelloError({ threadId: "t" })).toBeNull();
    expect(messageHelloError({ projectId: "p" })).toBeNull();
    expect(messageHelloError({})).toBeNull();
  });
});

describe("поиск предмета по seq события (§12.13)", () => {
  const events = [
    { id: "e1", seq: 11, type: "client/turn/requested", createdAt: 1000, data: { input: [{ text: "Сделай отчёт" }] } },
    { id: "e2", seq: 12, type: "item/completed", createdAt: 2000, data: { item: { type: "agentMessage", text: "Отчёт готов" } } },
    { id: "e3", seq: 13, type: "client/turn/requested", createdAt: 3000, data: { input: [{ text: "Сделай отчёт" }] } },
    { id: "e4", seq: 14, type: "item/completed", createdAt: 4000, data: { item: { type: "agentMessage", text: "Отчёт готов" } } },
  ];

  it("точное совпадение messageSeq → seq у обеих ролей", async () => {
    const sdk = fakeThreadsSdk(events);
    const owner = await resolveTargetMessage(sdk as never, "thr_testmsg01", 13);
    expect(owner?.role).toBe("owner");
    expect(owner?.number).toBe(3);
    const agent = await resolveTargetMessage(sdk as never, "thr_testmsg01", 12);
    expect(agent?.role).toBe("agent");
    expect(agent?.number).toBe(2);
  });

  it("одинаковые тексты не мешают: совпадение только по seq, не по тексту", async () => {
    const sdk = fakeThreadsSdk(events);
    const found = await resolveTargetMessage(sdk as never, "thr_testmsg01", 14);
    // «Отчёт готов» есть и у №2 (seq 12): предмет — именно №4 с seq 14
    expect(found?.number).toBe(4);
    expect(found?.seq).toBe(14);
  });

  it("нет события с таким seq → undefined (сервер отвечает message_not_found до старта звонка)", async () => {
    const sdk = fakeThreadsSdk(events);
    expect(await resolveTargetMessage(sdk as never, "thr_testmsg01", 99)).toBeUndefined();
  });

  it("пишущееся сообщение агента (item/started) в списке нет → message_not_found", async () => {
    const sdk = fakeThreadsSdk([
      ...events,
      { id: "e5", seq: 15, type: "item/started", createdAt: 5000, data: { item: { type: "agentMessage" } } },
    ]);
    expect(await resolveTargetMessage(sdk as never, "thr_testmsg01", 15)).toBeUndefined();
  });
});

describe("соседи предмета (§12.13 «Контекст»)", () => {
  const messages = [
    msg(1, "owner", "первый запрос"),
    msg(2, "agent", "ответ один"),
    msg(3, "owner", "уточнение"),
    msg(4, "agent", "ответ два"),
    msg(5, "agent", "ответ два продолжение"),
    msg(6, "owner", "следующий запрос"),
    msg(7, "agent", "ответ а"),
    msg(8, "agent", "ответ б"),
    msg(9, "agent", "ответ в"),
    msg(10, "agent", "ответ г"),
    msg(11, "agent", "ответ д"),
    msg(12, "owner", "последний запрос"),
  ];

  it("предмет — агент: ближайшее предыдущее сообщение владельца", () => {
    const n = messageNeighbors(messages, messages[4]);
    expect(n.map((m) => m.number)).toEqual([3]);
  });

  it("предмет — агент без владельца выше → соседей нет", () => {
    const only = [msg(1, "agent", "монолог")];
    expect(messageNeighbors(only, only[0])).toEqual([]);
  });

  it("предмет — владелец: следующие ответы агента до следующего владельца, не больше 3", () => {
    const n = messageNeighbors(messages, messages[5]);
    expect(n.map((m) => m.number)).toEqual([7, 8, 9]);
  });

  it("предмет — владелец с одним ответом → один сосед", () => {
    const n = messageNeighbors(messages, messages[2]);
    expect(n.map((m) => m.number)).toEqual([4, 5]);
  });

  it("предмет — последнее сообщение владельца → соседей нет", () => {
    const n = messageNeighbors(messages, messages[11]);
    expect(n).toEqual([]);
  });
});

describe("блок предмета (§12.13 «Контекст»)", () => {
  const target = msg(7, "agent", "Тело сообщения агента", 42);
  const ownerPrev = msg(6, "owner", "Запрос владельца", 41);

  it("без выделения: заголовок с ролью и временем + текст", () => {
    const block = formatMessageSubjectBlock(target, [ownerPrev]);
    expect(block).toContain("СООБЩЕНИЕ №7 (Агент,");
    expect(block).toContain("), ПО КОТОРОМУ ЗВОНЯТ:");
    expect(block).toContain("Тело сообщения агента");
    expect(block).not.toContain("ВЫДЕЛЕННЫЙ ФРАГМЕНТ");
  });

  it("с выделением: фрагмент, затем сообщение целиком", () => {
    const block = formatMessageSubjectBlock(target, [], "важный кусок");
    const sel = block.indexOf("ВЫДЕЛЕННЫЙ ФРАГМЕНТ СООБЩЕНИЯ №7:");
    const whole = block.indexOf("СООБЩЕНИЕ №7 ЦЕЛИКОМ:");
    expect(sel).toBeGreaterThanOrEqual(0);
    expect(whole).toBeGreaterThan(sel);
    expect(block).toContain("важный кусок");
    expect(block).toContain("Тело сообщения агента");
    expect(block).not.toContain("ПО КОТОРОМУ ЗВОНЯТ");
  });

  it("соседи — после текста предмета с пометкой КОНТЕКСТ ВОКРУГ", () => {
    const block = formatMessageSubjectBlock(target, [ownerPrev]);
    const ctx = block.indexOf("КОНТЕКСТ ВОКРУГ СООБЩЕНИЯ №7:");
    expect(ctx).toBeGreaterThan(block.indexOf("Тело сообщения агента"));
    expect(block).toContain("Запрос владельца");
  });

  it("без соседей пометки нет", () => {
    const block = formatMessageSubjectBlock(target, []);
    expect(block).not.toContain("КОНТЕКСТ ВОКРУГ");
  });
});

describe("окна сообщений 10+10 (§12.13 «Контекст»)", () => {
  const many = Array.from({ length: 47 }, (_, i) => msg(i + 1, i % 2 === 0 ? "owner" : "agent", `Сообщение ${i + 1}`));

  it("окна {10,10}: первые 10 + пропуск + последние 10", () => {
    const res = formatThreadMessagesBlock(many, { first: 10, last: 10 });
    expect(res.messagesCount).toBe(20);
    expect(res.skippedCount).toBe(27);
    expect(res.block).toContain("НАЧАЛО ТРЕДА (1–10)");
    expect(res.block).toContain("… пропущено 27 (дочитай `thread_read_messages`) …");
    expect(res.block).toContain("ПОСЛЕДНИЕ СООБЩЕНИЯ (38–47)");
    expect(res.block).toContain("[10] Агент");
    expect(res.block).toContain("[38] Агент");
    expect(res.block).not.toContain("[37] Владелец");
  });

  it("≤ 20 сообщений с окнами {10,10} — все без маркера", () => {
    const twenty = many.slice(0, 20);
    const res = formatThreadMessagesBlock(twenty, { first: 10, last: 10 });
    expect(res.skippedCount).toBe(0);
    expect(res.block).not.toContain("пропущено");
    expect(res.block).toContain("ПОСЛЕДНИЕ СООБЩЕНИЯ (1–20)");
  });

  it("по умолчанию окна звонка по треду 10+20 без изменений", () => {
    const res = formatThreadMessagesBlock(many);
    expect(res.messagesCount).toBe(30);
    expect(res.skippedCount).toBe(17);
    expect(res.block).toContain("ПОСЛЕДНИЕ СООБЩЕНИЯ (28–47)");
  });
});

describe("messageVoiceInstruction (§12.13 «Инструкция»)", () => {
  const ctx = {
    thread: { id: "thr_testmsg01", title: "Тестовый тред", project: "Тестовый проект" },
    nowUtc: "2026-11-15T00:00:00.000Z",
    threadState: { status: "свободен", lastMessageTime: "15.11 00:00", lastOwnerMessageIndex: 6, lastAgentMessageIndex: 7 },
    messagesBlock: "ПОСЛЕДНИЕ СООБЩЕНИЯ (1–7)\n\n[7] Агент:\nответ",
    memory: [] as string[],
    messageCall: {
      number: 7,
      role: "agent" as const,
      subjectBlock: "СООБЩЕНИЕ №7 (Агент, 15.11 00:00), ПО КОТОРОМУ ЗВОНЯТ:\nответ",
    },
  };

  it("роль — звонок по сообщению №n, предмет — блоком до сообщений треда", () => {
    const text = messageVoiceInstruction(ctx);
    expect(text).toContain("звонок по сообщению №7 (Агент) треда «Тестовый тред»");
    const subj = text.indexOf("СООБЩЕНИЕ №7 (Агент, 15.11 00:00), ПО КОТОРОМУ ЗВОНЯТ:");
    const msgs = text.indexOf("СООБЩЕНИЯ ТРЕДА:");
    expect(subj).toBeGreaterThanOrEqual(0);
    expect(msgs).toBeGreaterThan(subj);
  });

  it("первая реплика — MESSAGE_FIRST_REPLY_RULE вместо FIRST_REPLY_RULE", () => {
    const text = messageVoiceInstruction(ctx);
    expect(text).toContain(MESSAGE_FIRST_REPLY_RULE);
    expect(text).not.toContain(FIRST_REPLY_RULE);
    expect(text).toContain("объясни сообщение, по которому звонят");
    expect(text).toContain("Требование «подробно» действует только на первую реплику");
  });
});

class FakeWs {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: string[] = [];
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(public url: string) {
    FakeWs.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.fire("open", {});
    }, 0);
  }
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire("close", { code: 1000, reason: "" });
  }
  fire(type: string, ev: unknown) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
}

/** События длинного треда: seq i+1, owner на нечётных. Предмет №12 (агент) отвечает №11 (владелец). */
const longThreadEvents = Array.from({ length: 25 }, (_, i) => {
  const seq = i + 1;
  return seq % 2 === 1
    ? { id: `e${seq}`, seq, type: "client/turn/requested", createdAt: 1000 + seq, data: { input: [{ text: `Запрос ${seq}` }] } }
    : { id: `e${seq}`, seq, type: "item/completed", createdAt: 1000 + seq, data: { item: { type: "agentMessage", text: `Ответ ${seq}` } } };
});

function makeMessageCall(targetMessage?: ThreadMessage, selectedText?: string, events = longThreadEvents) {
  const store = new CallStore(new Database(":memory:"));
  const frames: ServerFrame[] = [];
  const fakeSdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => ({
        id: threadId,
        title: "Тред со звонком по сообщению",
        projectId: "proj_test",
        status: "idle",
      }),
      spawn: async () => ({ id: "thr_brain_spawned" }),
      list: async () => [],
      events: { list: async () => events },
    },
    projects: { list: async () => [{ id: "proj_test", name: "Тестовый проект" }] },
    environments: { get: async () => ({}) },
  };

  const s = new CallSession({
    callId: "call_mc",
    keys: ["k1", "k2"],
    voice: "Algenib",
    languageCode: "ru-RU",
    thinkingLevel: "LOW",
    mode: "extended",
    routerInput: "text",
    maxCallMinutes: 60,
    store,
    sdk: fakeSdk as never,
    targetThreadId: "thr_testmsg01",
    ...(targetMessage ? { targetMessage, ...(selectedText ? { targetSelectedText: selectedText } : {}) } : {}),
    toBrowser: (f) => frames.push(f),
    sendBrowserAudio: () => {},
    spawnCallThread: async () => null,
    advanceCallThread: async () => {},
    sayCallThread: async () => {},
    endCallThread: async () => {},
    wsFactory: (url) => new FakeWs(url) as unknown as WebSocket,
  });
  return { s, store, frames };
}

const eventKinds = (store: CallStore) => store.transcript("call_mc").map((r) => r.kind);
const eventPayload = (store: CallStore, kind: string) =>
  store.transcript("call_mc").filter((r) => r.kind === kind).map((r) => JSON.parse(r.payload));

describe("звонок по сообщению в сессии (§12.13)", () => {
  beforeEach(() => {
    FakeWs.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("call_started с полями предмета, message_context сразу после thread_context", async () => {
    const target = msg(12, "agent", "Ответ 12", 12);
    const { s, store } = makeMessageCall(target, "фрагмент ответа");
    await s.start();
    await vi.advanceTimersByTimeAsync(10);

    const started = eventPayload(store, "call_started");
    expect(started).toHaveLength(1);
    expect(started[0]).toEqual({
      targetThreadId: "thr_testmsg01",
      targetMessageSeq: 12,
      targetMessageNumber: 12,
      targetMessageRole: "agent",
      hasSelectedText: true,
    });

    const kinds = eventKinds(store);
    const tc = kinds.indexOf("thread_context");
    expect(tc).toBeGreaterThanOrEqual(0);
    expect(kinds[tc + 1]).toBe("message_context");
    const mc = eventPayload(store, "message_context");
    expect(mc[0]).toEqual({ number: 12, role: "agent", chars: "Ответ 12".length, selectedChars: "фрагмент ответа".length });
    await s.end("owner");
  });

  it("без выделения hasSelectedText=false и selectedChars нет", async () => {
    const target = msg(12, "agent", "Ответ 12", 12);
    const { s, store } = makeMessageCall(target);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(eventPayload(store, "call_started")[0]).toEqual({
      targetThreadId: "thr_testmsg01",
      targetMessageSeq: 12,
      targetMessageNumber: 12,
      targetMessageRole: "agent",
      hasSelectedText: false,
    });
    const mc = eventPayload(store, "message_context");
    expect(mc[0].selectedChars).toBeUndefined();
    await s.end("owner");
  });

  it("инструкция голоса: блок предмета до сообщений, окна 10+10, первая реплика предмета", async () => {
    const target = msg(12, "agent", "Ответ 12", 12);
    const { s } = makeMessageCall(target);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(FakeWs.all).toHaveLength(1);
    const setup = JSON.parse(FakeWs.all[0].sent[0]);
    const instruction = setup.setup.systemInstruction.parts[0].text;

    const subj = instruction.indexOf("СООБЩЕНИЕ №12 (Агент,");
    expect(subj).toBeGreaterThanOrEqual(0);
    expect(instruction.indexOf("СООБЩЕНИЯ ТРЕДА:")).toBeGreaterThan(subj);
    // Окна звонка по сообщению 10+10: предмет №12 попадает в пропуск, но приведён блоком.
    expect(instruction).toContain("НАЧАЛО ТРЕДА (1–10)");
    expect(instruction).toContain("… пропущено 5 (дочитай `thread_read_messages`) …");
    expect(instruction).toContain("ПОСЛЕДНИЕ СООБЩЕНИЯ (16–25)");
    expect(instruction).toContain("КОНТЕКСТ ВОКРУГ СООБЩЕНИЯ №12:");
    expect(instruction).toContain("Запрос 11");
    expect(instruction).toContain(MESSAGE_FIRST_REPLY_RULE);
    expect(instruction).not.toContain(FIRST_REPLY_RULE);
    expect(instruction).toContain("звонок по сообщению №12 (Агент)");
    await s.end("owner");
  });

  it("звонок по треду без предмета: окна 10+20 и call_started без полей сообщения", async () => {
    const { s, store } = makeMessageCall(undefined);
    await s.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(eventPayload(store, "call_started")[0]).toEqual({ targetThreadId: "thr_testmsg01" });
    expect(eventKinds(store)).not.toContain("message_context");
    const setup = JSON.parse(FakeWs.all[0].sent[0]);
    const instruction = setup.setup.systemInstruction.parts[0].text;
    // 25 сообщений ≤ 30 — все помещаются в окна 10+20 звонка по треду.
    expect(instruction).toContain("ПОСЛЕДНИЕ СООБЩЕНИЯ (1–25)");
    expect(instruction).not.toContain("ПО КОТОРОМУ ЗВОНЯТ");
    await s.end("owner");
  });
});

// ─── UI: слот messageAction и досылка полей в hello (§12.13 «Вход») ───

import appDef from "../app.js";
import { callEngine } from "../src/ui/engine.js";
import { setCustomRpcHandler } from "../src/ui/rpc.js";

class MockCloseEvent extends Event {
  code: number;
  reason: string;
  wasClean: boolean;
  constructor(type: string, init?: { code?: number; reason?: string; wasClean?: boolean }) {
    super(type);
    this.code = init?.code ?? 1000;
    this.reason = init?.reason ?? "";
    this.wasClean = init?.wasClean ?? true;
  }
}
if (typeof (globalThis as { CloseEvent?: unknown }).CloseEvent === "undefined") {
  (globalThis as { CloseEvent?: unknown }).CloseEvent = MockCloseEvent;
}

class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  sentMessages: string[] = [];
  binaryType = "arraybuffer";
  constructor(public url: string) {
    super();
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(new Event("open") as never), 0);
  }
  send(data: string | ArrayBuffer) {
    if (typeof data === "string") this.sentMessages.push(data);
  }
  close(code = 1000, reason = "") {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
  receiveMessage(data: string | ArrayBuffer) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
}

describe("UI: действие на сообщении и поля hello (§12.13)", () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  let messageActionReg: { id: string; title: string; icon?: string; run: (ctx: never) => void | Promise<void> } | undefined;

  const helloOf = (idx: number) => JSON.parse(MockWebSocket.instances[idx].sentMessages[0]);

  beforeEach(() => {
    MockWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    (globalThis as { WebSocket: unknown }).WebSocket = MockWebSocket;
    const eventTarget = new EventTarget();
    const windowMock = {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
      location: { protocol: "http:", host: "localhost:3000" },
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    };
    (globalThis as { window: unknown }).window = windowMock;
    (globalThis as { location: unknown }).location = windowMock.location;

    const mockApp = {
      slots: new Proxy(
        {},
        {
          get:
            () =>
            (reg: typeof messageActionReg) => {
              if (reg && (reg as { id?: string }).id === "call-message") messageActionReg = reg;
            },
        },
      ),
      experimental_sidebarFooter: { register: () => {} },
      commands: { register: () => {} },
    };
    (appDef as unknown as { setup(a: unknown): void }).setup(mockApp);
    setCustomRpcHandler(async (method) => (method === "callToken" ? { token: "tok_test" } : {}));
    callEngine.dismiss();
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    setCustomRpcHandler(null);
    callEngine.dismiss();
  });

  it("слот messageAction: id, заголовок и иконка телефона", () => {
    expect(messageActionReg).toBeDefined();
    expect(messageActionReg!.id).toBe("call-message");
    expect(messageActionReg!.title).toBe("Звонок по сообщению");
    expect(messageActionReg!.icon).toBe("live-call/phone");
  });

  it("run(context) → hello с threadId, messageSeq и selectedText", async () => {
    messageActionReg!.run({
      threadId: "thr_testmsg01",
      message: { id: "m9", threadId: "thr_testmsg01", role: "assistant", text: "t", sourceSeqEnd: 9, experimental_messageSeq: 9 },
      selectedText: "важный фрагмент",
    } as never);
    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(helloOf(0)).toEqual({
      type: "hello",
      protocol: 1,
      token: "tok_test",
      threadId: "thr_testmsg01",
      messageSeq: 9,
      selectedText: "важный фрагмент",
    });
  });

  it("selectedText режется до 4000 и не шлётся пустым", async () => {
    callEngine.start({ threadId: "thr_testmsg01", messageSeq: 4, selectedText: "б".repeat(5000) });
    await new Promise((r) => setTimeout(r, 10));
    const h = helloOf(0);
    expect(h.selectedText).toHaveLength(4000);
    expect(h.messageSeq).toBe(4);

    callEngine.dismiss();
    MockWebSocket.instances = [];
    callEngine.start({ threadId: "thr_testmsg01", messageSeq: 4, selectedText: "" });
    await new Promise((r) => setTimeout(r, 10));
    expect(helloOf(0)).toEqual({ type: "hello", protocol: 1, token: "tok_test", threadId: "thr_testmsg01", messageSeq: 4 });
  });

  it("при идущем звонке действие разворачивает док, второй звонок не начинается", async () => {
    callEngine.start({ threadId: "thr_testmsg01", messageSeq: 4 });
    await new Promise((r) => setTimeout(r, 10));
    expect(MockWebSocket.instances).toHaveLength(1);
    const before = callEngine.getSnapshot().expandSignal;
    messageActionReg!.run({
      threadId: "thr_testmsg01",
      message: { id: "m2", threadId: "thr_testmsg01", role: "assistant", text: "t", sourceSeqEnd: 3, experimental_messageSeq: 3 },
    } as never);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(callEngine.getSnapshot().expandSignal).toBe(before + 1);
  });

  it("возврат по обрыву сокета: resume-hello досылает messageSeq и selectedText", async () => {
    callEngine.start({ threadId: "thr_testmsg01", messageSeq: 6, selectedText: "фрагмент" });
    await new Promise((r) => setTimeout(r, 10));
    const sock = MockWebSocket.instances[0];
    sock.receiveMessage(JSON.stringify({ type: "ready", callId: "call_mc1", mode: "normal", voice: "Algenib", keys: { active: 1, of: 2 } }));
    sock.close(1006, "abnormal");
    await new Promise((r) => setTimeout(r, 600));
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const h = helloOf(1);
    expect(h).toMatchObject({ type: "hello", protocol: 1, resume: "call_mc1", messageSeq: 6, selectedText: "фрагмент" });
  });

  it("перезапуск после обрыва сервера: новое hello с threadId, messageSeq и selectedText", async () => {
    callEngine.start({ threadId: "thr_testmsg01", messageSeq: 6, selectedText: "фрагмент" });
    await new Promise((r) => setTimeout(r, 10));
    const sock = MockWebSocket.instances[0];
    sock.receiveMessage(JSON.stringify({ type: "ready", callId: "call_mc2", mode: "normal", voice: "Algenib", keys: { active: 1, of: 2 } }));
    sock.receiveMessage(JSON.stringify({ type: "error", code: "call_gone", message: "звонок уже завершён", retryable: false }));
    sock.close(1000, "call gone");
    await new Promise((r) => setTimeout(r, 10));
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const h = helloOf(1);
    expect(h).toMatchObject({ type: "hello", protocol: 1, threadId: "thr_testmsg01", messageSeq: 6, selectedText: "фрагмент" });
    expect(h.resume).toBeUndefined();
  });
});
