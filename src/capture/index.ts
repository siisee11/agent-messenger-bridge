/**
 * Capture module - tmux pane polling system
 */

export { CapturePoller } from './poller.js';
export { detectState, type AgentState } from './detector.js';
export { stripAnsi, cleanCapture, splitForDiscord, stripOuterCodeblock } from './parser.js';
