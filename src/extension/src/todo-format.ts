export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoLike {
  readonly id: string;
  readonly title: string;
  readonly status: TodoStatus;
}

/**
 * Builds the model-facing result text for set_todos.
 *
 * The complete stored list is echoed back (as OpenCode's todowrite does) so the
 * authoritative, validated state is present in the transcript as a tool result,
 * not only as the model's own call arguments. This lets the model re-anchor on
 * the latest list after long turns, and keeps it visible when a client trims or
 * summarizes older call arguments.
 */
export function formatSetTodosResult(todos: readonly TodoLike[]): string {
  if (!todos.length) return "Todo state cleared in AgentBridge. Current todo list: []";
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const current = todos.find((todo) => todo.status === "in_progress");
  const summary = `Todo state updated in AgentBridge: ${completed}/${todos.length} completed${current ? `; current todo ${current.id}: ${current.title}` : ""}.`;
  const list = JSON.stringify(todos.map(({ id, title, status }) => ({ id, title, status })), null, 2);
  return `${summary}\n\nCurrent todo list (authoritative; send the complete list to set_todos to change it):\n${list}`;
}
