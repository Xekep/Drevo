import { useEffect, useMemo, useState } from "react";
import type { Person, FamilyUnion } from "../../domain/types";
import type { TreeGeometry } from "../../domain/tree-layout";
import { spatialTopology, type SpatialWorld } from "../../domain/tree-spatial";
import type {
  SpatialLayoutReply,
  SpatialLayoutRequest,
} from "./spatial-layout-worker";

/** A geometry lifetime owns a Worker. Old workers terminate on scope changes;
 * their late messages can never restore people from a previous access scope. */
export function useSpatialWorld(
  people: ReadonlyMap<string, Person>,
  geometry: TreeGeometry | null,
  unions: readonly FamilyUnion[] | undefined,
) {
  const topology = useMemo(
    () => (geometry ? spatialTopology(people, geometry, unions) : null),
    [people, geometry, unions],
  );
  const [result, setResult] = useState<{
    topology: typeof topology;
    world?: SpatialWorld;
    failed?: boolean;
  } | null>(null);
  useEffect(() => {
    if (!topology) return;
    let active = true;
    let worker: Worker | null = null;
    const fail = () => {
      if (active) setResult({ topology, failed: true });
      worker?.terminate();
      worker = null;
    };
    try {
      worker = new Worker(
        new URL("./spatial-layout-worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = ({ data }: MessageEvent<SpatialLayoutReply>) => {
        if (!active || data.requestId !== 1) return;
        if (data.failed || !data.points) return fail();
        setResult({
          topology,
          world: {
            points: new Map(data.points),
            connections: topology.connections,
          },
        });
        worker?.terminate();
        worker = null;
      };
      worker.onerror = fail;
      worker.onmessageerror = fail;
      const request: SpatialLayoutRequest = {
        requestId: 1,
        flat: [...topology.flat],
        connections: topology.connections,
        reverse: topology.reverse,
      };
      worker.postMessage(request);
    } catch {
      fail();
    }
    return () => {
      active = false;
      worker?.terminate();
    };
  }, [topology]);
  return {
    world: result?.topology === topology ? result?.world || null : null,
    failed: result?.topology === topology && !!result?.failed,
  };
}
