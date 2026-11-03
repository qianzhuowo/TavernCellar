/**
 * Prompt preview (phase 5): assembles the next reply's prompt for the chat open in the tavern with the tavern's own
 * dry run (`Generate('normal', {}, true)`, the path its prompt manager uses to count tokens) and reports the final
 * prompt, its token counts and the world info entries that fired. Nothing is sent to a model and the chat is not
 * written. ST and tt run the same code. See docs/protocol.md (`prompt.preview`).
 */
import { ERR, ProtocolError, assertPreviewRequest } from '../../shared/protocol.js';
import { promptManager } from '../../../../../openai.js';

const ctx = () => SillyTavern.getContext();

/** Most world info entries whose tokens are counted one by one (each count may be a tokenizer request). */
const MAX_COUNTED_ENTRIES = 200;

/** Text of a chat completion message content (string, or parts with text and images). */
function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
    return content.map(part => (part?.type === 'text' ? String(part.text ?? '') : `[${part?.type ?? 'part'}]`)).join('\n');
}

/** Messages of a prompt manager collection in send order (nested collections flattened, empty ones dropped like getChat). */
function flatten(item, out = []) {
    if (Array.isArray(item?.collection)) {
        for (const child of item.collection) flatten(child, out);
    } else if (item && (item.content || item.tool_calls)) {
        out.push(item);
    }
    return out;
}

/**
 * Sections of the chat completion just assembled (one per prompt of the preset: main, world info, chat history…),
 * from the prompt manager's copy of it, with the tavern's own per-message token counts. Null when that copy does not
 * line up with the final messages (a listener changed them), so no section is ever attributed wrongly.
 */
function chatSections(finalCount) {
    const root = promptManager?.messages;
    if (!Array.isArray(root?.collection)) return null;
    const sections = [];
    const tokens = [];
    for (const item of root.collection) {
        const messages = flatten(item);
        if (!messages.length) continue;
        const sum = messages.reduce((n, m) => n + (Number(m.tokens) || 0), 0);
        let name = '';
        try { name = promptManager.getPromptById?.(item.identifier)?.name ?? ''; } catch { /* not a preset prompt */ }
        sections.push({ identifier: String(item.identifier ?? ''), name, start: tokens.length, count: messages.length, tokens: sum });
        for (const m of messages) tokens.push(Number(m.tokens) || 0);
    }
    return tokens.length === finalCount ? { sections, tokens } : null;
}

/** Projection of one activated world info entry (as the scan holds it) for the companion. */
function entryView(entry) {
    return {
        world: String(entry.world ?? ''),
        uid: entry.uid,
        comment: String(entry.comment ?? ''),
        keys: Array.isArray(entry.key) ? entry.key.map(String) : [],
        constant: Boolean(entry.constant),
        position: Number(entry.position ?? 0),
        depth: entry.depth ?? null,
        order: entry.order ?? null,
        role: entry.role ?? null,
        ...(entry.outletName ? { outletName: String(entry.outletName) } : {}),
        content: String(entry.content ?? ''),
    };
}

let running = false;

/**
 * Runs one dry run and collects what it produced.
 * @param {{input?: string}} payload input: optional test text, passed as the tavern's quiet prompt (appended as an
 *   instruction and scanned by world info, never written to the chat)
 */
export async function previewPrompt(payload) {
    assertPreviewRequest(payload);
    const c = ctx();
    if (running || document.body.dataset.generating === 'true') {
        throw new ProtocolError(ERR.BUSY, running ? '已有一个预览正在进行' : '酒馆正在生成回复，请等它结束后再预览');
    }
    if (c.groupId) throw new ProtocolError(ERR.NO_CHAT, '群聊暂不支持预览：请在酒馆里打开一个角色的聊天', { group: true });
    const character = c.characters?.[c.characterId];
    if (c.characterId === undefined || !character) throw new ProtocolError(ERR.NO_CHAT, '酒馆里没有打开角色：请先在酒馆里打开要测试的角色聊天');

    running = true;
    const { eventSource, eventTypes } = c;
    let scan = null;
    let data = null;
    const onScan = args => { scan = args; };
    const onData = (generateData, dryRun) => { if (dryRun) data = generateData; };
    eventSource.on(eventTypes.WORLDINFO_SCAN_DONE, onScan);
    eventSource.on(eventTypes.GENERATE_AFTER_DATA, onData);
    const input = payload.input?.trim() ?? '';
    try {
        await c.generate('normal', input ? { quiet_prompt: input } : {}, true);
    } finally {
        eventSource.removeListener(eventTypes.WORLDINFO_SCAN_DONE, onScan);
        eventSource.removeListener(eventTypes.GENERATE_AFTER_DATA, onData);
        running = false;
    }

    const api = String(c.mainApi ?? '');
    const raw = data?.prompt;
    if (raw == null) throw new ProtocolError(ERR.HOST_ERROR, '酒馆没有组装出提示词（可能缺少必需的设置，详见酒馆页面的控制台）');

    const prompt = {};
    const tokens = {};
    if (Array.isArray(raw)) {
        const messages = raw.map(m => ({ role: String(m?.role ?? ''), ...(m?.name ? { name: String(m.name) } : {}), content: contentText(m?.content) }));
        const counted = chatSections(messages.length);
        if (counted) {
            messages.forEach((m, i) => { m.tokens = counted.tokens[i]; });
            prompt.sections = counted.sections;
        } else {
            for (const m of messages) m.tokens = await c.getTokenCountAsync(m.content);
            tokens.approx = true;
        }
        prompt.messages = messages;
        tokens.total = messages.reduce((n, m) => n + m.tokens, 0);
        const settings = c.chatCompletionSettings ?? {};
        if (Number(settings.openai_max_context)) tokens.context = Number(settings.openai_max_context);
        if (Number(settings.openai_max_tokens)) tokens.response = Number(settings.openai_max_tokens);
    } else {
        prompt.text = String(raw);
        tokens.total = await c.getTokenCountAsync(prompt.text);
        if (Number(c.maxContext)) tokens.context = Number(c.maxContext);
    }

    const activated = scan?.activated?.entries instanceof Map ? [...scan.activated.entries.values()] : [];
    const entries = activated.map(entryView);
    for (const [i, entry] of entries.entries()) {
        if (i < MAX_COUNTED_ENTRIES) entry.tokens = entry.content ? await c.getTokenCountAsync(entry.content) : 0;
    }

    let model = '';
    try { model = api === 'openai' ? String(c.getChatCompletionModel?.() ?? '') : String(c.onlineStatus ?? ''); } catch { /* no model */ }
    return {
        api,
        ...(model && model !== 'no_connection' ? { model } : {}),
        chat: {
            character: { name: String(character.name ?? ''), avatar: String(character.avatar ?? '') },
            chatId: String(c.getCurrentChatId?.() ?? ''),
            messages: Array.isArray(c.chat) ? c.chat.length : 0,
        },
        ...(input ? { input } : {}),
        prompt,
        tokens,
        worldInfo: { entries, overflowed: Boolean(scan?.budget?.overflowed) },
        at: new Date().toISOString(),
    };
}
