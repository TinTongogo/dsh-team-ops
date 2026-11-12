/**
 * **里程碑清单的解析**（`docs/team/里程碑.md`）：把那张表读成 `phase` 的取值域。
 *
 * 这是一条纯函数：不碰 ctx、不碰文件系统，只把 Markdown 文本解析成行。引擎与面板宿主
 * 共用这一处，于是「面板上的 EPIC 卡」与「引擎认的阶段」不可能各说各话。
 *
 * 容忍度（这张表是人手写的，迟早会有人多加一列或省掉反引号）：
 *   · 只认 **表格行**（`|` 开头），表头与分隔行靠"第一格不是一个像编号的取值"挡掉；
 *   · 编号可以带反引号也可以不带；名称 / 出口准则 / 依赖 / 状态四格**缺哪格就留空**
 *     （缺格不是错误，是"这一项没写"）；
 *   · 行内 Markdown 装饰（`**粗体**`、反引号）剥掉，留下的就是人读的那串字。
 * **读不出任何一行不是异常**：清单可能还没建、或者人家用的是别的表形 —— 返回空数组，由调用方
 * 如实说"没读到里程碑清单"，**不臆造阶段名**。
 * @param markdown - `里程碑.md` 全文（任何输入都安全：非字符串按空串算）。
 * @returns `[{ code, name, exit, deps, status }]`（按文件里的顺序）。
 */
export function parseMilestones(markdown) {
	const text = typeof markdown === 'string' ? markdown : ''
	const plain = (value) =>
		String(value ?? '')
			.replace(/\*\*/g, '')
			.replace(/`/g, '')
			.replace(/\s+/g, ' ')
			.trim()
	const rows = []
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim().startsWith('|')) continue
		const cells = line.split('|').slice(1, -1)
		if (cells.length < 2) continue
		const code = plain(cells[0])
		// 表头（`编号`）与分隔行（`:--`）都会在这里被挡掉：编号必须长得像一个编号。
		if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(code)) continue
		rows.push({ code, name: plain(cells[1]), exit: plain(cells[2]), deps: plain(cells[3]), status: plain(cells[4]) })
	}
	return rows
}
