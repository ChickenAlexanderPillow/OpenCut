import type { Command } from "@/lib/commands";

const MAX_COMMAND_HISTORY = 10;

export class CommandManager {
	private history: Command[] = [];
	private redoStack: Command[] = [];

	private pushToHistory(command: Command): void {
		this.history.push(command);
		if (this.history.length > MAX_COMMAND_HISTORY) {
			this.history.splice(0, this.history.length - MAX_COMMAND_HISTORY);
		}
	}

	execute({ command }: { command: Command }): Command {
		command.execute();
		this.pushToHistory(command);
		this.redoStack = [];
		return command;
	}

	push({ command }: { command: Command }): void {
		this.pushToHistory(command);
		this.redoStack = [];
	}

	undo(): void {
		if (this.history.length === 0) return;
		const command = this.history.pop();
		command?.undo();
		if (command) {
			this.redoStack.push(command);
		}
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const command = this.redoStack.pop();
		command?.redo();
		if (command) {
			this.pushToHistory(command);
		}
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		this.history = [];
		this.redoStack = [];
	}
}
