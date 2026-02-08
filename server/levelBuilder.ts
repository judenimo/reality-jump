/**
 * DETERMINISTIC LEVEL BUILDER
 * ============================
 *
 * Takes raw AI object detections and builds a playable SceneV1 level.
 *
 * The AI only does perception (what objects are where). This module handles
 * all gameplay decisions: platform placement, spawn points, reachability,
 * pickups, enemies. Because it's deterministic code (not AI), every level
 * is guaranteed to be completable.
 *
 * Output conforms to the SceneV1 Zod schema in
 * src/shared/schema/scene_v1.schema.ts
 */

// ---------------------------------------------------------------------------
// Types — AI detection input
// ---------------------------------------------------------------------------

export interface Detection {
    label: string;
    category: 'furniture' | 'food' | 'plant' | 'electric' | 'other';
    confidence: number;
    bounds_normalized: { x: number; y: number; w: number; h: number };
}

export interface DetectionResponse {
    image: { w: number; h: number };
    detections: Detection[];
}

// ---------------------------------------------------------------------------
// Types — SceneV1 output (mirrors schema, no Zod import needed server-side)
// ---------------------------------------------------------------------------

interface Bounds {
    x: number; y: number; w: number; h: number;
}

interface SceneObject {
    id: string;
    type: 'platform' | 'obstacle' | 'collectible' | 'hazard';
    label: string;
    confidence: number;
    bounds_normalized: Bounds;
    surface_type?: 'solid' | 'soft';
    category?: 'furniture' | 'food' | 'plant' | 'electric' | 'other';
    enemy_spawn_anchor?: boolean;
}

interface SpawnPoint {
    x: number; y: number;
}

interface EnemySpawn extends SpawnPoint {
    type: string;
}

interface PickupSpawn extends SpawnPoint {
    type: string;
}

interface SceneV1 {
    version: 1;
    image: { w: number; h: number };
    objects: SceneObject[];
    spawns: {
        player: SpawnPoint;
        exit: SpawnPoint;
        enemies: EnemySpawn[];
        pickups: PickupSpawn[];
    };
    rules: unknown[];
}

// ---------------------------------------------------------------------------
// Constants — tuned to match Phaser physics
// ---------------------------------------------------------------------------

/** Max vertical distance (normalized) a player can jump.
 *  PhysicsConfig uses defaultJumpHeightFraction=0.35, so 0.25 is safe. */
const MAX_JUMP_HEIGHT = 0.25;

/** Max horizontal gap the player can cover with a running jump. */
const MAX_HORIZONTAL_REACH = 0.40;

/** Minimum platform width to keep. Narrower ones are dropped. */
const MIN_PLATFORM_WIDTH = 0.08;

/** Thin platform height for the walking surface. */
const PLATFORM_THICKNESS = 0.03;

/** Max number of platforms (including ground). */
const MAX_PLATFORMS = 10;

/** How far above a platform surface to place entities. */
const ENTITY_OFFSET_Y = 0.06;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

/** Check horizontal overlap between two intervals [a.x, a.x+a.w] and [b.x, b.x+b.w]. */
function horizontalOverlap(a: Bounds, b: Bounds): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x;
}

/** Horizontal distance between nearest edges of two platforms. */
function horizontalGap(a: Bounds, b: Bounds): number {
    const aRight = a.x + a.w;
    const bRight = b.x + b.w;
    if (a.x < bRight && aRight > b.x) return 0; // overlap
    return Math.min(Math.abs(a.x - bRight), Math.abs(b.x - aRight));
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildLevel(input: DetectionResponse): SceneV1 {
    const { image, detections } = input;
    const objects: SceneObject[] = [];
    let idCounter = 0;
    const nextId = (prefix: string) => `${prefix}_${idCounter++}`;

    // -----------------------------------------------------------------------
    // Step A: Convert detections to candidate platforms & other objects
    // -----------------------------------------------------------------------

    interface PlatformCandidate {
        label: string;
        category: Detection['category'];
        confidence: number;
        bounds: Bounds;
        isBridge: boolean;
        isGround: boolean;
        enemyAnchor: boolean;
    }

    const candidates: PlatformCandidate[] = [];
    const collectibleDetections: Detection[] = [];
    const obstacleDetections: Detection[] = [];

    for (const det of detections) {
        if (det.category === 'food') {
            // Food items become collectibles, not platforms
            collectibleDetections.push(det);
            continue;
        }

        // Use the TOP EDGE of the detection as a platform surface
        const platBounds: Bounds = {
            x: clamp(det.bounds_normalized.x, 0, 0.95),
            y: clamp(det.bounds_normalized.y, 0.05, 0.90),
            w: clamp(det.bounds_normalized.w, 0.05, 0.9),
            h: PLATFORM_THICKNESS,
        };

        if (platBounds.w < MIN_PLATFORM_WIDTH) {
            // Too narrow — treat as obstacle instead
            obstacleDetections.push(det);
            continue;
        }

        candidates.push({
            label: det.label,
            category: det.category,
            confidence: det.confidence,
            bounds: platBounds,
            isBridge: false,
            isGround: false,
            enemyAnchor: det.category === 'plant' || det.category === 'electric',
        });
    }

    // -----------------------------------------------------------------------
    // Step B: Add ground platform
    // -----------------------------------------------------------------------

    candidates.push({
        label: 'ground',
        category: 'furniture',
        confidence: 1.0,
        bounds: { x: 0.0, y: 0.92, w: 1.0, h: PLATFORM_THICKNESS },
        isBridge: false,
        isGround: true,
        enemyAnchor: false,
    });

    // -----------------------------------------------------------------------
    // Step C: Sort by Y descending (bottom first, ground at start)
    // -----------------------------------------------------------------------

    candidates.sort((a, b) => b.bounds.y - a.bounds.y);

    // -----------------------------------------------------------------------
    // Step D: De-duplicate overlapping platforms at similar heights
    // -----------------------------------------------------------------------

    const filtered: PlatformCandidate[] = [];
    for (const cand of candidates) {
        const tooClose = filtered.some(
            (existing) =>
                Math.abs(existing.bounds.y - cand.bounds.y) < 0.05 &&
                horizontalOverlap(existing.bounds, cand.bounds)
        );
        if (tooClose) continue;
        filtered.push(cand);
    }

    // Limit to MAX_PLATFORMS
    const platforms = filtered.slice(0, MAX_PLATFORMS);

    // -----------------------------------------------------------------------
    // Step E: Ensure reachability — insert bridge platforms where needed
    // -----------------------------------------------------------------------

    // Sort bottom-to-top for gap analysis (descending Y = bottom first)
    platforms.sort((a, b) => b.bounds.y - a.bounds.y);

    let bridgesInserted = true;
    let iterations = 0;
    while (bridgesInserted && iterations < 10) {
        bridgesInserted = false;
        iterations++;

        for (let i = 0; i < platforms.length - 1; i++) {
            const lower = platforms[i];
            const upper = platforms[i + 1];
            const vertGap = lower.bounds.y - upper.bounds.y;

            if (vertGap > MAX_JUMP_HEIGHT) {
                // Insert a bridge platform between them
                const midY = (lower.bounds.y + upper.bounds.y) / 2;

                // Horizontally, place it between the two platforms
                const lowerCenterX = lower.bounds.x + lower.bounds.w / 2;
                const upperCenterX = upper.bounds.x + upper.bounds.w / 2;
                const bridgeX = clamp((lowerCenterX + upperCenterX) / 2 - 0.075, 0.02, 0.85);

                const bridge: PlatformCandidate = {
                    label: 'bridge',
                    category: 'other',
                    confidence: 1.0,
                    bounds: { x: bridgeX, y: midY, w: 0.15, h: PLATFORM_THICKNESS },
                    isBridge: true,
                    isGround: false,
                    enemyAnchor: false,
                };

                platforms.splice(i + 1, 0, bridge);
                bridgesInserted = true;
                break; // Re-sort and re-check from the start
            }

            // Also check horizontal reachability
            const hGap = horizontalGap(lower.bounds, upper.bounds);
            if (hGap > MAX_HORIZONTAL_REACH) {
                // Insert a stepping-stone platform
                const midY = (lower.bounds.y + upper.bounds.y) / 2;
                const midX = clamp(
                    (lower.bounds.x + lower.bounds.w / 2 + upper.bounds.x + upper.bounds.w / 2) / 2 - 0.075,
                    0.02, 0.85
                );

                const bridge: PlatformCandidate = {
                    label: 'stepping stone',
                    category: 'other',
                    confidence: 1.0,
                    bounds: { x: midX, y: midY, w: 0.15, h: PLATFORM_THICKNESS },
                    isBridge: true,
                    isGround: false,
                    enemyAnchor: false,
                };

                platforms.splice(i + 1, 0, bridge);
                bridgesInserted = true;
                break;
            }
        }

        // Re-sort after insertion
        platforms.sort((a, b) => b.bounds.y - a.bounds.y);
    }

    // Cap platforms at 12 (schema limit)
    while (platforms.length > 12) platforms.pop();

    // -----------------------------------------------------------------------
    // Step F: Build platform objects
    // -----------------------------------------------------------------------

    for (const plat of platforms) {
        objects.push({
            id: nextId(plat.isGround ? 'ground' : plat.isBridge ? 'bridge' : 'plat'),
            type: 'platform',
            label: plat.label,
            confidence: plat.confidence,
            bounds_normalized: plat.bounds,
            surface_type: plat.category === 'furniture' ? 'solid' : 'solid',
            category: plat.category === 'other' ? 'other' : plat.category,
            enemy_spawn_anchor: plat.enemyAnchor,
        });
    }

    // -----------------------------------------------------------------------
    // Step G: Add obstacle objects from narrow detections
    // -----------------------------------------------------------------------

    for (const det of obstacleDetections.slice(0, 4)) {
        objects.push({
            id: nextId('obs'),
            type: 'obstacle',
            label: det.label,
            confidence: det.confidence,
            bounds_normalized: det.bounds_normalized,
            category: det.category,
            enemy_spawn_anchor: det.category === 'plant' || det.category === 'electric',
        });
    }

    // -----------------------------------------------------------------------
    // Step H: Add collectible objects from food detections
    // -----------------------------------------------------------------------

    for (const det of collectibleDetections.slice(0, 5)) {
        objects.push({
            id: nextId('col'),
            type: 'collectible',
            label: det.label,
            confidence: det.confidence,
            bounds_normalized: det.bounds_normalized,
            category: 'food',
        });
    }

    // -----------------------------------------------------------------------
    // Step I: Player spawn — on ground, far left
    // -----------------------------------------------------------------------

    const groundPlat = platforms.find((p) => p.isGround) || platforms[0];
    const playerSpawn: SpawnPoint = {
        x: 0.08,
        y: groundPlat.bounds.y - ENTITY_OFFSET_Y,
    };

    // -----------------------------------------------------------------------
    // Step J: Exit — on/near the highest platform, far right
    // -----------------------------------------------------------------------

    // Highest = smallest Y
    const sortedByHeight = [...platforms].sort((a, b) => a.bounds.y - b.bounds.y);
    const highestPlat = sortedByHeight[0];
    const exitSpawn: SpawnPoint = {
        x: clamp(highestPlat.bounds.x + highestPlat.bounds.w - 0.05, 0.7, 0.95),
        y: highestPlat.bounds.y - ENTITY_OFFSET_Y,
    };

    // -----------------------------------------------------------------------
    // Step K: Place pickups on platforms (not ground, not bridges)
    // -----------------------------------------------------------------------

    const pickupPlatforms = platforms.filter((p) => !p.isGround && !p.isBridge);
    const pickups: PickupSpawn[] = [];

    // Place one pickup per non-ground/bridge platform
    for (let i = 0; i < pickupPlatforms.length && pickups.length < 5; i++) {
        const plat = pickupPlatforms[i];
        pickups.push({
            x: clamp(plat.bounds.x + plat.bounds.w / 2, 0.05, 0.95),
            y: plat.bounds.y - ENTITY_OFFSET_Y,
            type: i === 0 ? 'health' : 'coin',
        });
    }

    // If we have fewer than 3, add some on bridge platforms
    if (pickups.length < 3) {
        const bridgePlats = platforms.filter((p) => p.isBridge);
        for (const bp of bridgePlats) {
            if (pickups.length >= 4) break;
            pickups.push({
                x: clamp(bp.bounds.x + bp.bounds.w / 2, 0.05, 0.95),
                y: bp.bounds.y - ENTITY_OFFSET_Y,
                type: 'coin',
            });
        }
    }

    // If still fewer than 3, add on ground
    if (pickups.length < 3) {
        pickups.push({ x: 0.3, y: groundPlat.bounds.y - ENTITY_OFFSET_Y, type: 'coin' });
        pickups.push({ x: 0.5, y: groundPlat.bounds.y - ENTITY_OFFSET_Y, type: 'coin' });
    }

    // -----------------------------------------------------------------------
    // Step L: Place enemies on wider platforms
    // -----------------------------------------------------------------------

    const enemyPlatforms = platforms
        .filter((p) => !p.isGround && !p.isBridge && p.bounds.w > 0.15)
        .slice(0, 2);

    const enemies: EnemySpawn[] = [];
    for (const plat of enemyPlatforms) {
        enemies.push({
            x: clamp(plat.bounds.x + plat.bounds.w / 2, 0.05, 0.95),
            y: plat.bounds.y - ENTITY_OFFSET_Y,
            type: 'walker',
        });
        // Mark platform as enemy anchor
        const platObj = objects.find(
            (o) => o.type === 'platform' && o.bounds_normalized === plat.bounds
        );
        if (platObj) platObj.enemy_spawn_anchor = true;
    }

    // -----------------------------------------------------------------------
    // Step M: Assemble final SceneV1
    // -----------------------------------------------------------------------

    const scene: SceneV1 = {
        version: 1,
        image: { w: image.w, h: image.h },
        objects,
        spawns: {
            player: playerSpawn,
            exit: exitSpawn,
            enemies,
            pickups,
        },
        rules: [],
    };

    return scene;
}
