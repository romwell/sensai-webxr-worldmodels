import * as THREE from "three";
import {
  AudioSource,
  AudioUtils,
  createSystem,
  Entity,
  eq,
  Hovered,
  InputComponent,
  Interactable,
  PanelDocument,
  PanelUI,
  PlaybackMode,
  UIKit,
  UIKitDocument,
  VisibilityState,
} from "@iwsdk/core";
import { makeEntityRenderOnTop } from "./uiPanel.js";

// ------------------------------------------------------------
// Data shapes (mirrors public/splats/out_dymax_hi/game_flowers.json)
// ------------------------------------------------------------
interface FlowerManifestEntry {
  id: string;
  position: [number, number, number];
  boxSize: number;
  group: string;
  role: string;
  audio: string;
}

interface GroupManifestEntry {
  id: string;
  bpm: number;
  loopDuration: number;
  members: string[];
}

interface GameManifest {
  sampleRate: number;
  groups: GroupManifestEntry[];
  flowers: FlowerManifestEntry[];
}

const MANIFEST_URL = "./splats/out_dymax_hi/game_flowers.json";
const GAME_UI_CONFIG = "./ui/gameUI.json";
const HIT_RADIUS = 0.55;
const ORB_RADIUS = 0.16;
const RAY_LENGTH_M = 20;

/**
 * idle        - not selected; orb shown gray at rest, blue while aimed at
 * blinking    - the single most-recently-activated flower, currently
 *               accepting a new selection (yellow, blinking)
 * solidYellow - any other flower in the active chain: already played, or
 *               queued and waiting for its turn (yellow, steady)
 * solidRed    - the active chain was joined by a different-group flower;
 *               every active member turns red for the remainder of the
 *               shared loop, then the whole chain resets (red, steady)
 * finale      - the group is fully found; every member plays together once
 *               more (green, steady)
 * completed   - finale finished; permanently found, non-interactable
 *               (bright green)
 */
type FlowerPhase =
  | "idle"
  | "blinking"
  | "solidYellow"
  | "solidRed"
  | "finale"
  | "completed";

interface FlowerEntry {
  id: string;
  groupId: string;
  position: THREE.Vector3;
  boxSize: number;
  entity: Entity;
  hitMesh: THREE.Mesh;
  orb: THREE.Mesh;
  phase: FlowerPhase;
}

interface GroupEntry {
  id: string;
  bpm: number;
  loopDurationMs: number;
  memberIds: string[];
  completed: boolean;
}

interface ChainState {
  groupId: string;
  loopDurationMs: number;
  members: string[];
  joinWindowEnd: number; // performance.now() ms
  pendingJoin: string | null;
  resolved: boolean;
  // True once the group has been fully found and is playing its final
  // shared join-loop; the next boundary triggers the finale playback
  // instead of the normal join/no-join branches.
  awaitingFinale: boolean;
}

interface ScheduledCallback {
  time: number;
  cb: () => void;
}

const IDLE_GRAY = 0x9ca3af;
const HOVER_BLUE = 0x4fc3f7;
const ACTIVE_YELLOW = 0xffe066;
const ACTIVE_RED = 0xff5252;
const FOUND_GREEN = 0x4ade80;
const ORB_HOVER_SCALE = 1.2;

const PHASE_COLOR: Record<Exclude<FlowerPhase, "idle">, number> = {
  blinking: ACTIVE_YELLOW,
  solidYellow: ACTIVE_YELLOW,
  solidRed: ACTIVE_RED,
  finale: FOUND_GREEN,
  completed: FOUND_GREEN,
};

// ------------------------------------------------------------
// System
// ------------------------------------------------------------
export class FlowerGameSystem extends createSystem({
  gameUI: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", GAME_UI_CONFIG)],
  },
}) {
  private flowers = new Map<string, FlowerEntry>();
  private groups = new Map<string, GroupEntry>();

  private manifestLoaded = false;
  private gameActive = false;
  private hasStarted = false;

  private chain: ChainState | null = null;
  private pendingCallbacks: ScheduledCallback[] = [];
  private victoryTriggered = false;

  private congratsText: UIKit.Text | null = null;
  private playAgainRow: UIKit.Text | null = null;
  private uiEntity: Entity | null = null;
  private fanfareEntity: Entity | null = null;

  private rayLengthPatched = { left: false, right: false };

  // ----------------------------------------------------------
  init() {
    this.queries.gameUI.subscribe(
      "qualify",
      (entity) => {
        makeEntityRenderOnTop(entity);
        this.uiEntity = entity;
        if (entity.object3D) entity.object3D.visible = false;

        const document = PanelDocument.data.document[
          entity.index
        ] as UIKitDocument;
        if (!document) return;

        this.congratsText = document.getElementById(
          "congrats-text",
        ) as UIKit.Text;
        this.playAgainRow = document.getElementById(
          "playagain-row",
        ) as UIKit.Text;

        const restartButton = document.getElementById(
          "restart-button",
        ) as UIKit.Text;
        restartButton.addEventListener("click", () => this.resetGame());
      },
      true,
    );

    this.cleanupFuncs.push(
      this.visibilityState.subscribe((state) => {
        this.gameActive = state !== VisibilityState.NonImmersive;
        if (this.gameActive && !this.hasStarted) {
          this.hasStarted = true;
          this.startGame().catch((err) => {
            console.error("[FlowerGame] Failed to start game:", err);
          });
        }
      }),
    );
  }

  // ----------------------------------------------------------
  // Setup
  // ----------------------------------------------------------
  private async startGame(): Promise<void> {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) {
      throw new Error(`Failed to load ${MANIFEST_URL}: ${res.status}`);
    }
    const manifest = (await res.json()) as GameManifest;

    for (const g of manifest.groups) {
      this.groups.set(g.id, {
        id: g.id,
        bpm: g.bpm,
        loopDurationMs: g.loopDuration * 1000,
        memberIds: [...g.members],
        completed: false,
      });
    }

    for (const f of manifest.flowers) {
      this.buildFlower(f);
    }

    this.fanfareEntity = this.world.createTransformEntity();
    this.fanfareEntity.addComponent(AudioSource, {
      src: "./audio/fanfare.wav",
      volume: 1.0,
      loop: false,
      autoplay: false,
      positional: false,
      playbackMode: PlaybackMode.Restart,
    });

    this.manifestLoaded = true;

    const preloadTargets = [...this.flowers.values()].map((f) => f.entity);
    if (this.fanfareEntity) preloadTargets.push(this.fanfareEntity);

    await Promise.all(
      preloadTargets.map((entity) =>
        AudioUtils.preload(entity).catch((err) => {
          console.warn(`[FlowerGame] Audio preload failed:`, err);
        }),
      ),
    );

    console.log(
      `[FlowerGame] Ready: ${this.flowers.size} flowers across ${this.groups.size} groups.`,
    );
  }

  private buildFlower(f: FlowerManifestEntry): void {
    const position = new THREE.Vector3(...f.position);

    // Solid, opaque orb hovering above the flower — sized to read clearly
    // from across the room, even at rest.
    const orbHeight = position.y + f.boxSize * 1.4 + 0.12;
    const orbPosition = new THREE.Vector3(position.x, orbHeight, position.z);

    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(ORB_RADIUS, 20, 20),
      new THREE.MeshBasicMaterial({
        color: IDLE_GRAY,
        toneMapped: false,
      }),
    );
    orb.position.copy(orbPosition);
    orb.renderOrder = 500;

    this.scene.add(orb);

    // Invisible hit target for raycasting, centered on the orb (not the
    // flower) and generously sized so it's easy to aim at from across the
    // room — kept fully transparent.
    const hitMesh = new THREE.Mesh(
      new THREE.SphereGeometry(HIT_RADIUS, 12, 12),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: false,
      }),
    );
    hitMesh.position.copy(orbPosition);

    // hitMesh becomes the entity's own object3D so IWSDK's InputSystem
    // registers it as a raycast target and manages Hovered/Pressed tags,
    // using the same pointer mechanism that already works for panel UI.
    const entity = this.world.createTransformEntity(hitMesh);
    entity
      .addComponent(Interactable)
      .addComponent(AudioSource, {
        src: f.audio,
        volume: 0.9,
        loop: false,
        autoplay: false,
        positional: true,
        refDistance: 1.2,
        rolloffFactor: 1.2,
        maxDistance: 18,
        playbackMode: PlaybackMode.Restart,
      });

    this.flowers.set(f.id, {
      id: f.id,
      groupId: f.group,
      position,
      boxSize: f.boxSize,
      entity,
      hitMesh,
      orb,
      phase: "idle",
    });
  }

  // ----------------------------------------------------------
  // Frame loop
  // ----------------------------------------------------------
  update(_delta: number, _time: number): void {
    const now = performance.now();

    this.processScheduledCallbacks(now);
    this.updateChain(now);

    if (this.uiEntity?.object3D?.visible) this.positionUIPanel();

    if (this.gameActive) this.extendPointerRayLength();

    const hoveredId = this.gameActive ? this.findHoveredFlower() : null;
    this.animateOrbs(now, hoveredId);

    if (!this.gameActive || !this.manifestLoaded) return;

    const rightGamepad = this.input.gamepads.right;
    if (
      hoveredId &&
      rightGamepad?.getButtonDown(InputComponent.Trigger)
    ) {
      this.onFlowerTriggered(hoveredId, now);
    }
  }

  private findHoveredFlower(): string | null {
    for (const f of this.flowers.values()) {
      if (f.phase === "idle" && f.entity.hasComponent(Hovered)) return f.id;
    }
    return null;
  }

  /**
   * IWSDK's controller ray pointer defaults to a 1m reach (the underlying
   * @pmndrs/pointer-events RayIntersector's default `linePoints`), with no
   * exposed option to configure it. Extend it in place so flowers are
   * selectable from across the room, retried each frame (cheap) until both
   * pointers exist since they're created lazily once a controller connects.
   */
  private extendPointerRayLength(): void {
    if (this.rayLengthPatched.left && this.rayLengthPatched.right) return;
    for (const handedness of ["left", "right"] as const) {
      if (this.rayLengthPatched[handedness]) continue;
      try {
        const multiPointer = (this.input.multiPointers as Record<string, unknown>)[
          handedness
        ] as
          | { ray?: { pointer?: { intersector?: { options?: Record<string, unknown> } } } }
          | undefined;
        const intersector = multiPointer?.ray?.pointer?.intersector;
        if (!intersector) continue;
        intersector.options = {
          ...intersector.options,
          linePoints: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, RAY_LENGTH_M)],
        };
        this.rayLengthPatched[handedness] = true;
      } catch (err) {
        console.warn(`[FlowerGame] Could not extend ${handedness} ray length:`, err);
        this.rayLengthPatched[handedness] = true; // don't retry forever on failure
      }
    }
  }

  private processScheduledCallbacks(now: number): void {
    if (this.pendingCallbacks.length === 0) return;
    const due: ScheduledCallback[] = [];
    const remaining: ScheduledCallback[] = [];
    for (const item of this.pendingCallbacks) {
      (item.time <= now ? due : remaining).push(item);
    }
    if (due.length === 0) return;
    this.pendingCallbacks = remaining;
    due.sort((a, b) => a.time - b.time);
    for (const item of due) item.cb();
  }

  private scheduleAt(time: number, cb: () => void): void {
    this.pendingCallbacks.push({ time, cb });
  }

  private animateOrbs(now: number, hoveredId: string | null): void {
    for (const f of this.flowers.values()) {
      if (f.phase === "idle") {
        // Always visible, solid gray so it reads from across the room even
        // at rest; grows and turns blue while directly aimed at.
        const hovered = f.id === hoveredId;
        f.orb.visible = true;
        this.setOrbScale(f, hovered ? ORB_HOVER_SCALE : 1.0);
        this.setOrbColor(f, hovered ? HOVER_BLUE : IDLE_GRAY);
        continue;
      }

      this.setOrbScale(f, 1.0);

      if (f.phase === "blinking") {
        // Each on/off half-cycle lasts one eighth note at the flower's
        // group's BPM: eighth note = 60/bpm/2 seconds, so the toggle
        // frequency (a full on+off cycle) is bpm/60 Hz.
        const bpm = this.groups.get(f.groupId)?.bpm ?? 120;
        const blinkHz = bpm / 60;
        const blinkOn = Math.sin((now / 1000) * blinkHz * Math.PI * 2) > 0;
        f.orb.visible = blinkOn;
        this.setOrbColor(f, PHASE_COLOR.blinking);
        continue;
      }

      f.orb.visible = true;

      if (f.phase === "completed") {
        const pulse = 1.0 + 0.18 * (0.5 + 0.5 * Math.sin((now / 1000) * 2.2));
        this.setOrbScale(f, pulse);
        this.setOrbColor(f, FOUND_GREEN);
      } else {
        this.setOrbColor(f, PHASE_COLOR[f.phase]);
      }
    }
  }

  private setOrbScale(f: FlowerEntry, scale: number): void {
    f.orb.scale.setScalar(scale);
  }

  private setOrbColor(f: FlowerEntry, color: number): void {
    (f.orb.material as THREE.MeshBasicMaterial).color.setHex(color);
  }

  // ----------------------------------------------------------
  // Playback helpers
  // ----------------------------------------------------------
  private playFlowerOnce(id: string): void {
    const f = this.flowers.get(id);
    if (!f) return;
    AudioUtils.play(f.entity);
  }

  private setFlowerPhase(id: string, phase: FlowerPhase): void {
    const f = this.flowers.get(id);
    if (!f) return;
    f.phase = phase;
  }

  // ----------------------------------------------------------
  // Chain / group game logic
  // ----------------------------------------------------------
  private onFlowerTriggered(id: string, now: number): void {
    const f = this.flowers.get(id);
    if (!f || f.phase !== "idle") return;

    if (!this.chain) {
      // State A -> B: the only active flower, playing its first loop, blinking.
      const group = this.groups.get(f.groupId)!;
      const durationMs = group.loopDurationMs;
      this.playFlowerOnce(id);
      this.setFlowerPhase(id, "blinking");
      this.chain = {
        groupId: f.groupId,
        loopDurationMs: durationMs,
        members: [id],
        joinWindowEnd: now + durationMs,
        pendingJoin: null,
        resolved: false,
        awaitingFinale: false,
      };
      return;
    }

    const chain = this.chain;
    if (
      chain.awaitingFinale ||
      now >= chain.joinWindowEnd ||
      chain.members.includes(id)
    ) {
      return; // no new flower can be activated right now — ignore.
    }

    // State B/D -> C: a new flower is queued. It hasn't started playing yet
    // (waiting for the current blinker's loop to finish), so everything
    // active shows solid yellow — nothing blinks while a join is pending.
    if (chain.pendingJoin && chain.pendingJoin !== id) {
      // A previously-queued candidate got superseded by this click — release
      // it back to idle instead of leaving it stuck.
      this.setFlowerPhase(chain.pendingJoin, "idle");
    }
    chain.pendingJoin = id;
    this.setFlowerPhase(id, "solidYellow");
    const tailId = chain.members[chain.members.length - 1];
    if (tailId) this.setFlowerPhase(tailId, "solidYellow");
  }

  private updateChain(now: number): void {
    const chain = this.chain;
    if (!chain || chain.resolved) return;
    if (now < chain.joinWindowEnd) return;
    chain.resolved = true;

    const joinTime = chain.joinWindowEnd;
    const durationMs = chain.loopDurationMs;

    if (chain.awaitingFinale) {
      // State D(complete) -> F: the final join-loop just finished; now every
      // member of the group sings together once, in green.
      const finaleMembers = chain.members.slice();
      const group = this.groups.get(chain.groupId)!;
      for (const m of finaleMembers) this.playFlowerOnce(m);
      for (const m of finaleMembers) this.setFlowerPhase(m, "finale");
      this.scheduleAt(joinTime + durationMs, () => {
        for (const m of finaleMembers) this.setFlowerPhase(m, "completed");
        group.completed = true;
        if (this.chain === chain) this.chain = null;
        this.checkOverallWin();
      });
      return;
    }

    const pendingId = chain.pendingJoin;

    if (!pendingId) {
      // State B/D -> A: nothing was selected during the blinker's loop — no
      // second playback starts, and the chain resets immediately.
      const members = chain.members.slice();
      for (const m of members) this.setFlowerPhase(m, "idle");
      this.chain = null;
      return;
    }

    const tailId = chain.members[chain.members.length - 1];
    const pf = this.flowers.get(pendingId)!;
    const group = this.groups.get(chain.groupId)!;
    const sameGroup = pf.groupId === chain.groupId;
    const wouldComplete =
      sameGroup && chain.members.length + 1 === group.memberIds.length;

    if (tailId) this.playFlowerOnce(tailId); // tail's 2nd loop, now that something joined
    this.playFlowerOnce(pendingId); // joiner's 1st loop, shared with the tail's 2nd
    chain.members.push(pendingId);
    chain.pendingJoin = null;

    if (!sameGroup) {
      // State C -> E: a different-group flower joined. Every active member
      // turns solid red for this shared loop, then the whole chain resets.
      const allMembers = chain.members.slice();
      for (const m of allMembers) this.setFlowerPhase(m, "solidRed");
      this.scheduleAt(joinTime + durationMs, () => {
        for (const m of allMembers) this.setFlowerPhase(m, "idle");
        if (this.chain === chain) this.chain = null;
      });
      return;
    }

    if (wouldComplete) {
      // State C -> D(complete): the group is now fully found. This shared
      // loop still plays in yellow (no blink — nothing more can be
      // selected); the finale (green) happens on the next boundary.
      for (const m of chain.members) this.setFlowerPhase(m, "solidYellow");
      chain.joinWindowEnd = joinTime + durationMs;
      chain.resolved = false;
      chain.awaitingFinale = true;
    } else {
      // State C -> D: the joiner becomes the new blinker; everyone else
      // (already solid yellow) is unchanged.
      this.setFlowerPhase(pendingId, "blinking");
      chain.joinWindowEnd = joinTime + durationMs;
      chain.resolved = false;
    }
  }

  // ----------------------------------------------------------
  // Win / restart
  // ----------------------------------------------------------
  private checkOverallWin(): void {
    if (this.victoryTriggered) return;
    const allComplete = [...this.groups.values()].every((g) => g.completed);
    if (!allComplete) return;
    this.victoryTriggered = true;
    this.playVictorySequence();
  }

  private playVictorySequence(): void {
    this.showCongrats(true);

    const groupList = [...this.groups.values()];
    const GAP_MS = 500;
    let t = performance.now() + 600;

    for (const g of groupList) {
      const startAt = t;
      this.scheduleAt(startAt, () => {
        for (const id of g.memberIds) this.playFlowerOnce(id);
      });
      t += g.loopDurationMs + GAP_MS;
    }

    this.scheduleAt(t + 300, () => {
      this.showPlayAgainPrompt(true);
    });
  }

  private resetGame(): void {
    this.chain = null;
    this.pendingCallbacks = [];
    this.victoryTriggered = false;
    for (const f of this.flowers.values()) this.setFlowerPhase(f.id, "idle");
    for (const g of this.groups.values()) g.completed = false;
    this.hidePanels();
  }

  private showCongrats(visible: boolean): void {
    if (this.uiEntity?.object3D) {
      this.uiEntity.object3D.visible = visible;
      if (visible) {
        this.positionUIPanel();
        if (this.fanfareEntity) AudioUtils.play(this.fanfareEntity);
      }
    }
    this.congratsText?.setProperties({ display: visible ? "flex" : "none" });
  }

  private showPlayAgainPrompt(visible: boolean): void {
    this.playAgainRow?.setProperties({ display: visible ? "flex" : "none" });
  }

  private hidePanels(): void {
    if (this.uiEntity?.object3D) this.uiEntity.object3D.visible = false;
    this.playAgainRow?.setProperties({ display: "none" });
  }

  /**
   * Keeps the splash floating a fixed distance in front of the player,
   * facing them, updated every frame while visible. The victory montage
   * runs for several seconds before this panel is needed, so a
   * one-time-computed position risks ending up out of reach or behind the
   * player by the time they actually look for it.
   */
  private positionUIPanel(): void {
    const object3D = this.uiEntity?.object3D;
    if (!object3D) return;
    const forward = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    object3D.position
      .copy(this.camera.position)
      .addScaledVector(forward, 2.0);
    object3D.position.y = Math.max(this.camera.position.y - 0.1, 1.2);
    object3D.lookAt(
      this.camera.position.x,
      object3D.position.y,
      this.camera.position.z,
    );
  }
}
