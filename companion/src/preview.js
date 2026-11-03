/**
 * Prompt preview (phase 5): asks a connected Cellar Link to dry-run the next reply of the chat open in its tavern and
 * annotates the result with the workspace items it involves. Preview always shows the tavern's own content; local
 * edits are synced first (Studio offers that), never injected. See docs/protocol.md (`prompt.preview`).
 */
import { ERR, MSG, PREVIEW_TIMEOUT_MS, ProtocolError, assertPreviewRequest } from '../../shared/protocol.js';

/**
 * @param {{targets: import('./targets.js').TargetRegistry, workspace: () => import('./workspace/workspace.js').Workspace}} deps
 * @param {{target?: string, input?: string}} body
 */
export async function previewPrompt({ targets, workspace }, { target, input } = {}) {
    const request = input === undefined || input === '' ? {} : { input };
    assertPreviewRequest(request);
    const { target: t, link } = resolveLive(targets, target);
    if (!t.preview) throw new ProtocolError(ERR.BAD_REQUEST, `${t.label} 的 Cellar Link 版本不支持提示词预览，请更新插件后刷新酒馆页面`);
    const result = await link.request(MSG.PROMPT_PREVIEW, request, PREVIEW_TIMEOUT_MS);
    const ws = workspace();
    const pathOf = (kind, id) => (id ? ws.findBinding(t.id, kind, id)?.item.path ?? null : null);
    const character = result.chat?.character;
    if (character) character.path = pathOf('character', character.avatar);
    for (const entry of result.worldInfo?.entries ?? []) entry.path = pathOf('lorebook', entry.world);
    return { target: t.id, ...result };
}

/** A live target: the dry run needs the tavern page, so offline links (data folders) never preview. */
function resolveLive(targets, spec) {
    const live = targets.list();
    if (!spec) {
        if (live.length === 1) return targets.tryGetLive(live[0].id);
        throw new ProtocolError(live.length ? ERR.BAD_REQUEST : ERR.NOT_CONNECTED, live.length ? 'Several taverns are connected; specify a target' : '没有已连接的酒馆：预览需要打开装有 Cellar Link 的酒馆页面');
    }
    const matches = live.filter(x => x.id === spec || x.id.startsWith(spec));
    const exact = matches.find(x => x.id === spec);
    if (exact || matches.length === 1) return targets.tryGetLive((exact ?? matches[0]).id);
    throw new ProtocolError(matches.length ? ERR.BAD_REQUEST : ERR.NOT_CONNECTED, matches.length ? `Target prefix "${spec}" is ambiguous` : '这个酒馆没有连接：预览需要打开装有 Cellar Link 的酒馆页面');
}
