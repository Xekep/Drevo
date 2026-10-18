import {
  BufferAttribute,
  InstancedBufferAttribute,
  type BufferGeometry,
} from "three";
import type { SpatialWorld } from "../../domain/tree-spatial";

/** Endpoint positions are uploaded with topology, never rebuilt on animation ticks. */
export function setSpatialEdgeEndpoints(
  geometry: BufferGeometry,
  world: SpatialWorld,
  connections: SpatialWorld["connections"],
  instanced = false,
) {
  const copies = instanced ? 1 : 2;
  for (const [attribute, endpoint] of [
    ["edgeFrom", "from"],
    ["edgeTo", "to"],
  ] as const) {
    const values = new Float32Array(connections.length * copies * 3);
    connections.forEach((edge, i) => {
      const point = world.points.get(edge[endpoint])!;
      for (let copy = 0; copy < copies; copy++)
        values.set([point.x, point.y, point.z], (i * copies + copy) * 3);
    });
    geometry.setAttribute(
      attribute,
      instanced
        ? new InstancedBufferAttribute(values, 3)
        : new BufferAttribute(values, 3),
    );
  }
}

// Endpoint bounds use the same camera and pixel clamps as the billboards.
// Include the gaps between portrait/name/date so a terminal line cannot
// reappear inside the card after crossing the photograph. An incident edge
// must not paint over its own person,
// even when perspective puts part of the edge in front of that billboard.
export const edgeEndpointVertexDeclarations = `
attribute vec3 edgeFrom; attribute vec3 edgeTo;
uniform vec2 labelViewport;
uniform float labelFocal; uniform float labelMinPixels; uniform float labelMaxPixels;
varying vec4 edgeFromLabel; varying vec4 edgeToLabel;
vec4 projectEdgeLabel(vec3 point) {
  vec4 p=viewMatrix*vec4(point,1.);
  if(p.z>=-1.)return vec4(0.);
  float pixels=clamp(220.*labelFocal/(-p.z),labelMinPixels,labelMaxPixels);
  vec4 clip=projectionMatrix*p;
  return vec4(clip.xy/clip.w*.5+.5,pixels/labelViewport);
}`;

export const edgeEndpointVertex = `
edgeFromLabel=projectEdgeLabel(edgeFrom);
edgeToLabel=projectEdgeLabel(edgeTo);`;

export const edgeEndpointFragmentDeclarations = `
uniform vec2 labelViewport;
varying vec4 edgeFromLabel; varying vec4 edgeToLabel;
bool insideEdgeLabel(vec2 screen,vec4 label) {
  if(label.z<=0.)return false;
  vec2 p=(screen-label.xy)/label.zw;
  float pixels=label.z*labelViewport.x;
  float padding=1./pixels;
  float bottom=pixels>110.?-.525:-.405;
  return abs(p.x)<.46+padding&&p.y>bottom-padding&&p.y<.445+padding;
}`;

export const edgeEndpointClip = `
vec2 edgeScreen=gl_FragCoord.xy/viewport;
if(insideEdgeLabel(edgeScreen,edgeFromLabel)||insideEdgeLabel(edgeScreen,edgeToLabel))discard;`;
