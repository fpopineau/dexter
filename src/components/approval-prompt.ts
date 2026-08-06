import { Container, Text } from '@mariozechner/pi-tui';
import type { ApprovalDecision } from '../agent/types.js';
import { createApprovalSelector } from './select-list.js';
import { theme } from '../theme.js';

function formatToolLabel(tool: string): string {
  return tool
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export class ApprovalPromptComponent extends Container {
  readonly selector: any;
  onSelect?: (decision: ApprovalDecision) => void;

  constructor(tool: string, args: Record<string, unknown>) {
    super();
    const tradeTool = tool === 'ibkr_orders' || tool === 'accept_proposal';
    this.selector = createApprovalSelector(
        (decision) => this.onSelect?.(decision),
        { allowSession: !tradeTool },
    );
    const width = Math.max(20, process.stdout.columns ?? 80);
    const border = theme.warning('─'.repeat(width));
    // The operator must see WHAT they approve: the path for file edits,
    // the full argument payload for everything else — an order approval
    // reading "<unknown>" is a blind signature (audit finding 2).
    const path = typeof args.path === 'string' && args.path
        ? (args.path as string)
        : JSON.stringify(args).slice(0, 300);

    this.addChild(new Text(border, 0, 0));
    this.addChild(new Text(theme.warning(theme.bold('Permission required')), 0, 0));
    this.addChild(new Text(`${formatToolLabel(tool)} ${path}`, 0, 0));
    this.addChild(new Text(theme.muted('Do you want to allow this?'), 0, 0));
    this.addChild(new Text('', 0, 0));
    this.addChild(this.selector);
    this.addChild(new Text('', 0, 0));
    this.addChild(new Text(theme.muted('Enter to confirm · esc to deny'), 0, 0));
    this.addChild(new Text(border, 0, 0));
  }
}
