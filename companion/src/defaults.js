/**
 * Data of items created in Cellar (POST /api/create), before they exist in any tavern.
 * The chat completion preset is SillyTavern's default/content/presets/openai/Default.json without the connection
 * settings (source, models, proxy), so a new preset does not switch the user's API when selected.
 */
import { GLOBAL_REGEX_ID } from '../../shared/protocol.js';

export const DEFAULT_OPENAI_PRESET = Object.freeze({
    "temperature": 1,
    "frequency_penalty": 0,
    "presence_penalty": 0,
    "top_p": 1,
    "top_k": 0,
    "top_a": 0,
    "min_p": 0,
    "repetition_penalty": 1,
    "openai_max_context": 4095,
    "openai_max_tokens": 300,
    "names_behavior": 0,
    "send_if_empty": "",
    "impersonation_prompt": "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]",
    "new_chat_prompt": "[Start a new Chat]",
    "new_group_chat_prompt": "[Start a new group chat. Group members: {{group}}]",
    "new_example_chat_prompt": "[Example Chat]",
    "continue_nudge_prompt": "[Continue your last message without repeating its original content.]",
    "bias_preset_selected": "Default (none)",
    "max_context_unlocked": false,
    "wi_format": "{0}",
    "scenario_format": "{{scenario}}",
    "personality_format": "{{personality}}",
    "group_nudge_prompt": "[Write the next reply only as {{char}}.]",
    "stream_openai": true,
    "prompts": [
        {
            "name": "Main Prompt",
            "system_prompt": true,
            "role": "system",
            "content": "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}.",
            "identifier": "main"
        },
        {
            "name": "Auxiliary Prompt",
            "system_prompt": true,
            "role": "system",
            "content": "",
            "identifier": "nsfw"
        },
        {
            "identifier": "dialogueExamples",
            "name": "Chat Examples",
            "system_prompt": true,
            "marker": true
        },
        {
            "name": "Post-History Instructions",
            "system_prompt": true,
            "role": "system",
            "content": "",
            "identifier": "jailbreak"
        },
        {
            "identifier": "chatHistory",
            "name": "Chat History",
            "system_prompt": true,
            "marker": true
        },
        {
            "identifier": "worldInfoAfter",
            "name": "World Info (after)",
            "system_prompt": true,
            "marker": true
        },
        {
            "identifier": "worldInfoBefore",
            "name": "World Info (before)",
            "system_prompt": true,
            "marker": true
        },
        {
            "identifier": "enhanceDefinitions",
            "role": "system",
            "name": "Enhance Definitions",
            "content": "If you have more knowledge of {{char}}, add to the character's lore and personality to enhance them but keep the Character Sheet's definitions absolute.",
            "system_prompt": true,
            "marker": false
        },
        {
            "identifier": "charDescription",
            "name": "Char Description",
            "system_prompt": true,
            "marker": true
        },
        {
            "identifier": "charPersonality",
            "name": "Char Personality",
            "system_prompt": true,
            "marker": true
        },
        {
            "identifier": "scenario",
            "name": "Scenario",
            "system_prompt": true,
            "marker": true
        },
        {
            "identifier": "personaDescription",
            "name": "Persona Description",
            "system_prompt": true,
            "marker": true
        }
    ],
    "prompt_order": [
        {
            "character_id": 100000,
            "order": [
                {
                    "identifier": "main",
                    "enabled": true
                },
                {
                    "identifier": "worldInfoBefore",
                    "enabled": true
                },
                {
                    "identifier": "charDescription",
                    "enabled": true
                },
                {
                    "identifier": "charPersonality",
                    "enabled": true
                },
                {
                    "identifier": "scenario",
                    "enabled": true
                },
                {
                    "identifier": "enhanceDefinitions",
                    "enabled": false
                },
                {
                    "identifier": "nsfw",
                    "enabled": true
                },
                {
                    "identifier": "worldInfoAfter",
                    "enabled": true
                },
                {
                    "identifier": "dialogueExamples",
                    "enabled": true
                },
                {
                    "identifier": "chatHistory",
                    "enabled": true
                },
                {
                    "identifier": "jailbreak",
                    "enabled": true
                }
            ]
        },
        {
            "character_id": 100001,
            "order": [
                {
                    "identifier": "main",
                    "enabled": true
                },
                {
                    "identifier": "worldInfoBefore",
                    "enabled": true
                },
                {
                    "identifier": "personaDescription",
                    "enabled": true
                },
                {
                    "identifier": "charDescription",
                    "enabled": true
                },
                {
                    "identifier": "charPersonality",
                    "enabled": true
                },
                {
                    "identifier": "scenario",
                    "enabled": true
                },
                {
                    "identifier": "enhanceDefinitions",
                    "enabled": false
                },
                {
                    "identifier": "nsfw",
                    "enabled": true
                },
                {
                    "identifier": "worldInfoAfter",
                    "enabled": true
                },
                {
                    "identifier": "dialogueExamples",
                    "enabled": true
                },
                {
                    "identifier": "chatHistory",
                    "enabled": true
                },
                {
                    "identifier": "jailbreak",
                    "enabled": true
                }
            ]
        }
    ],
    "assistant_prefill": "",
    "assistant_impersonation": "",
    "use_sysprompt": false,
    "squash_system_messages": false,
    "media_inlining": true,
    "continue_prefill": false,
    "continue_postfix": " ",
    "seed": -1,
    "n": 1
});

/** New character card (V3, like the tavern's create endpoint writes it); the avatar is set when published. */
export function newCharacter(name, { world = '' } = {}) {
    const fields = { name, description: '', personality: '', scenario: '', first_mes: '', mes_example: '' };
    return {
        ...fields,
        creatorcomment: '',
        avatar: 'none',
        talkativeness: '0.5',
        fav: false,
        tags: [],
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
            ...fields,
            creator_notes: '',
            system_prompt: '',
            post_history_instructions: '',
            tags: [],
            creator: '',
            character_version: '',
            alternate_greetings: [],
            extensions: { talkativeness: '0.5', fav: false, world, depth_prompt: { prompt: '', depth: 4, role: 'system' } },
            group_only_greetings: [],
        },
        create_date: new Date().toISOString(),
    };
}

/** Item id and data of a new item of `kind` called `name` (presets: chat completion; characters: linked `world`). */
export function newItem(kind, name, { world } = {}) {
    if (kind === 'character') return { id: name, data: newCharacter(name, { world: world ?? '' }) };
    if (kind === 'lorebook') return { id: name, data: { entries: {} } };
    if (kind === 'preset') return { id: `openai/${name}`, data: structuredClone(DEFAULT_OPENAI_PRESET) };
    return { id: GLOBAL_REGEX_ID, data: { scripts: [] } };
}
