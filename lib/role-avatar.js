/**
 * 角色头像与色调的**唯一正文**：图标名、色调档位、分类回落，以及自定义头像文件名。
 *
 * 从 `team/team-runtime.js` 分出来：这一整段是纯数据 + 纯函数（不碰 ctx、不读账本），
 * 面板宿主与引擎都要用；放在引擎里只会让引擎继续变胖。
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'

/** 色调 → 分类的回落（角色没写 `category` 时用；写了就以它为准）。 */
export const ROLE_CATEGORY_BY_TONE = { eng: '研发', design: '设计', data: '数据', biz: '业务', ops: '运维', exec: '管理' }

/** 角色自定义头像的文件名（放角色目录里即可；卡片优先用它，没有再退回 emoji 圆底）。 */
export const AVATAR_FILE_NAMES = ['avatar.svg', 'avatar.png', 'avatar.webp', 'avatar.jpg', 'avatar.jpeg']

/**
 * 角色目录里有没有自定义头像文件。
 * @param dir - 角色目录绝对路径。
 * @returns 命中文件名，或 null。
 */
export function avatarFileIn(dir) {
	for (const name of AVATAR_FILE_NAMES) {
		try {
			if (statSync(join(dir, name)).isFile()) return name
		} catch {
			continue
		}
	}
	return null
}

/**
 * 角色头像：**图标名 + 色调**，一处正文（面板的卡片、工具回执都读它，免得两处各画一套）。
 *
 * **值不再是 emoji，而是图标名**（人的指令：「emoji 头像能否改成不带色彩的开源图标」）：
 *   · 引擎这一处只给**名字**（`target` / `crown` / `cog` …），几何在浏览器那一半 —— 那是表现层的事，
 *     引擎不该内嵌 SVG 字符串（同一份名字还要给工具回执用，那里根本没有 SVG）。
 *   · 名表按 Lucide / Feather 那套 24×24 描边图标的命名与规范取的（**几何是照规范自己画的**，
 *     不是它们的原版路径 —— 本机取不到原版，所以不主张原样搬运；风格一致、且一律 `currentColor`）。
 *   · 色相由浏览器那一半的五档中性透明度给（面板里不许有颜色），所以图标只描边、不上色。
 *
 * 为什么按角色而不是按成员：同一角色的成员看起来该像"同一类人"，而自定义角色（用户自己
 * 加进 `roles/` 的）也必须有个**确定的**头像 —— 所以未收录的角色回落到通用图标（`user`），
 * 色调按 id 取模到一个固定的少数几档（同一 id 永远同一色，不随成员增减而变）。
 */
export const ROLE_AVATAR_ICONS = {
	ceo: 'crown',
	'product-owner': 'clipboard',
	analyst: 'trend',
	architect: 'landmark',
	'backend-engineer': 'cog',
	'frontend-engineer': 'browser',
	'devops-engineer': 'terminal',
	security: 'shield',
	'ux-designer': 'pencil',
	'ai-engineer': 'bot',
	'data-engineer': 'database',
	ontology: 'network',
	reviewer: 'search',
	qa: 'flask',
	marketer: 'speaker',
	'content-editor': 'document',
	sales: 'dollar',
	'customer-success-manager': 'message',
	finance: 'coins',
	legal: 'scale',
}

/** 未收录角色回落到的那一个图标名（不是空白）。 */
export const AVATAR_ICON_FALLBACK = 'user'

/** 头像色调的档位（前端只认这几个类名）；未收录的角色按 id 稳定取一档。 */
export const AVATAR_TONES = ['eng', 'design', 'data', 'biz', 'ops', 'exec']
/** 已收录角色的色调归属。 */
const ROLE_TONES = {
	ceo: 'exec',
	'product-owner': 'biz',
	analyst: 'data',
	architect: 'eng',
	'backend-engineer': 'eng',
	'frontend-engineer': 'eng',
	'devops-engineer': 'ops',
	security: 'ops',
	'ai-engineer': 'data',
	'data-engineer': 'data',
	ontology: 'data',
	qa: 'ops',
	reviewer: 'ops',
	'ux-designer': 'design',
	marketer: 'biz',
	'content-editor': 'design',
	sales: 'biz',
	'customer-success-manager': 'biz',
	finance: 'biz',
	legal: 'biz',
}

/**
 * 一个角色的头像图标名。
 * @param role - 角色 id（自定义角色也认）。
 * @returns 图标名（在浏览器那一半的 `AVATAR_ICONS` 里找几何）；未收录的回落 `user`。
 */
export function avatarOf(role) {
	const key = typeof role === 'string' ? role : ''
	return ROLE_AVATAR_ICONS[key] ?? AVATAR_ICON_FALLBACK
}

/**
 * 一个角色的头像色调：收录过的按归属，未收录的按 id 稳定取模（**同一 id 永远同一档**）。
 * @param role - 角色 id。
 * @returns `eng` / `design` / `data` / `biz` / `ops` / `exec` 之一。
 */
export function avatarToneOf(role) {
	const key = typeof role === 'string' ? role : ''
	if (ROLE_TONES[key] !== undefined) return ROLE_TONES[key]
	let hash = 0
	for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) % 1000003
	return AVATAR_TONES[hash % AVATAR_TONES.length]
}

