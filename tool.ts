// 工具定义包装：introduction + 参数兜底 + 可选 render
//
// render 把 data 渲染成模型侧文本；给出后 data 仅用于界面与日志
// 未给出时沿用宿主旧规则（data.content 或序列化）

import type {
    AgentCallToolResult,
    AgentTool,
    AgentToolParamSpec,
} from "wellspring/api/host/index.ts"

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function tool(
    name: string,
    content: string,
    params: Record<string, AgentToolParamSpec>,
    call: (args: Record<string, unknown>) => Promise<AgentCallToolResult>,
    render?: (data: Record<string, unknown>) => string,
): AgentTool {
    return {
        name,
        introduction: { params, content },
        call: async (...values: unknown[]) => {
            const input = isObject(values[0]) ? values[0] : {}
            const result = await call(input)
            if (render === undefined) {
                return result
            }
            return { success: result.success, data: result.data, content: render(result.data) }
        },
    }
}
