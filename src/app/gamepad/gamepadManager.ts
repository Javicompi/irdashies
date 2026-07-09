import type { KeybindingActionId, KeybindingsMap } from '@irdashies/types';
import { gamepadComboToken, isGamepadBinding } from '@irdashies/shared';
import logger from '../logger';
import { GamepadHost } from './gamepadHost';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const D = (...a: unknown[]) => { try { appendFileSync(join(tmpdir(),'irdashies-gpad.log'), `[GPAD] ${a.join(' ')}\n`); } catch {} };

let didFirstSync = false;

export class GamepadManager {
  private map = new Map<string, KeybindingActionId>();
  private held = new Set<string>();
  private host?: GamepadHost;
  private onCapture?: (token: string) => void;
  private captureHeld = new Set<string>();

  constructor(private triggerAction: (actionId: KeybindingActionId) => void) {}

  public syncBindings(bindings: KeybindingsMap): void {
    this.map.clear();
    let c = 0;
    for (const [actionId, entry] of Object.entries(bindings)) {
      if (isGamepadBinding(entry.accelerator)) {
        this.map.set(entry.accelerator, actionId as KeybindingActionId);
        c++;
        if (!didFirstSync) D(`bind: ${entry.accelerator} -> ${actionId}`);
      }
    }
    if (!didFirstSync) {
      didFirstSync = true;
      D(`syncBindings done: ${c} gamepad bindings, mapSize=${this.map.size}`);
    }
    this.held.clear();
  }

  private handleButton(token: string, down: boolean): void {
    if (this.onCapture) {
      D(`capture: ${token} down=${down}`);
      if (down) {
        this.captureHeld.add(token);
      } else if (this.captureHeld.size > 0) {
        const combo = gamepadComboToken(this.captureHeld);
        this.captureHeld.clear();
        this.onCapture(combo);
      }
      return;
    }

    if (!down) {
      this.held.delete(token);
      return;
    }
    this.held.add(token);
    const combo = gamepadComboToken(this.held);
    let actionId = this.map.get(combo);
    if (!actionId) {
      // Held may contain phantom buttons (e.g. Fanatec wheel always-pressed
      // controls). Fallback: try just the newly-pressed token alone.
      D(`fallback: combo miss, trying single token "${token}"`);
      actionId = this.map.get(token);
    }
    if (actionId) { D(`FIRE: ${actionId}`); this.triggerAction(actionId); }
  }

  public start(): void {
    try {
      if (!this.host) this.host = new GamepadHost();
      this.host.start((token, down) => this.handleButton(token, down));
    } catch (err) {
      logger.error(
        '[Gamepad] host unavailable, controller bindings disabled',
        err
      );
    }
  }

  public stop(): void {
    this.host?.stop();
  }

  public startCapture(onCapture: (token: string) => void): void {
    this.captureHeld.clear();
    this.onCapture = onCapture;
  }

  public stopCapture(): void {
    this.onCapture = undefined;
    this.captureHeld.clear();
    this.held.clear();
  }
}
