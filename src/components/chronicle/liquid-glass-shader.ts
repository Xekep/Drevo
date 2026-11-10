/**
 * Glass / Default from Liquid Morphology Slideshow by filipz (MIT).
 * https://codepen.io/filipz/pen/JoGNQzm
 * Copyright notice and permission: public/licenses/liquid-morphology-MIT.txt.
 * Drevo: contain UVs, transparent-photo background and exact endpoints.
 * Default uniform values are folded into constants; the original wave is retained.
 */
export const liquidGlassFragment = `
precision highp float;
uniform sampler2D uTexture1;
uniform sampler2D uTexture2;
uniform float uProgress;
uniform vec2 uResolution;
uniform vec2 uTexture1Size;
uniform vec2 uTexture2Size;
varying vec2 vUv;

vec2 getContainUV(vec2 uv, vec2 textureSize) {
  vec2 s = uResolution / textureSize;
  vec2 scaledSize = textureSize * min(s.x, s.y);
  vec2 offset = (uResolution - scaledSize) * 0.5;
  return (uv * uResolution - offset) / scaledSize;
}
vec4 photo(sampler2D image, vec2 uv) {
  vec4 background = vec4(vec3(0.0352941176), 1.0);
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return background;
  vec4 sampleColor = texture2D(image, uv);
  return vec4(mix(background.rgb, sampleColor.rgb, sampleColor.a), 1.0);
}
float noise(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float smoothNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(noise(i), noise(i + vec2(1.0, 0.0)), f.x),
    mix(noise(i + vec2(0.0, 1.0)), noise(i + vec2(1.0, 1.0)), f.x), f.y);
}
vec4 glassEffect(vec2 uv, float progress) {
  float glassStrength = 0.08;
  float chromaticAberration = 0.02;
  float waveDistortion = 0.025;
  float clearCenterSize = 0.3;
  float surfaceRipples = 0.004;
  float liquidFlow = 0.015;
  float rimLightWidth = 0.05;
  float glassEdgeWidth = 0.025;
  float brightnessPhase = smoothstep(0.8, 1.0, progress);
  float rimLightIntensity = 0.08 * (1.0 - brightnessPhase);
  float glassEdgeOpacity = 0.06 * (1.0 - brightnessPhase);
  vec2 center = vec2(0.5, 0.5);
  vec2 p = uv * uResolution;
  vec2 uv1 = getContainUV(uv, uTexture1Size);
  vec2 uv2_base = getContainUV(uv, uTexture2Size);
  if (progress <= 0.0) return photo(uTexture1, uv1);
  if (progress >= 1.0) return photo(uTexture2, uv2_base);
  float maxRadius = length(uResolution) * 0.85;
  float bubbleRadius = progress * maxRadius;
  vec2 sphereCenter = center * uResolution;
  float dist = length(p - sphereCenter);
  float normalizedDist = dist / max(bubbleRadius, 0.001);
  vec2 direction = (dist > 0.0) ? (p - sphereCenter) / dist : vec2(0.0);
  // Equivalent to the original reversed-edge smoothstep, defined on every GPU.
  float inside = 1.0 - smoothstep(bubbleRadius - 3.0, bubbleRadius + 3.0, dist);
  float distanceFactor = smoothstep(clearCenterSize, 1.0, normalizedDist);
  float time = progress * 5.0;
  vec2 liquidSurface = vec2(smoothNoise(uv * 100.0 + time * 0.3),
    smoothNoise(uv * 100.0 + time * 0.2 + 50.0)) - 0.5;
  liquidSurface *= surfaceRipples * distanceFactor;
  vec2 distortedUV = uv2_base;
  if (inside > 0.0) {
    float refractionOffset = glassStrength * pow(distanceFactor, 1.5);
    vec2 flowDirection = normalize(direction + vec2(sin(time), cos(time * 0.7)) * 0.3);
    distortedUV -= flowDirection * refractionOffset;
    float wave1 = sin(normalizedDist * 22.0 - time * 3.5);
    float wave2 = sin(normalizedDist * 35.0 + time * 2.8) * 0.7;
    float wave3 = sin(normalizedDist * 50.0 - time * 4.2) * 0.5;
    float combinedWave = (wave1 + wave2 + wave3) / 3.0;
    float waveOffset = combinedWave * waveDistortion * distanceFactor;
    distortedUV -= direction * waveOffset + liquidSurface;
    vec2 flowOffset = vec2(sin(time + normalizedDist * 10.0),
      cos(time * 0.8 + normalizedDist * 8.0)) * liquidFlow * distanceFactor * inside;
    distortedUV += flowOffset;
  }
  vec4 newImg;
  if (inside > 0.0) {
    float aberrationOffset = chromaticAberration * pow(distanceFactor, 1.2);
    vec2 uv_r = distortedUV + direction * aberrationOffset * 1.2;
    vec2 uv_g = distortedUV + direction * aberrationOffset * 0.2;
    vec2 uv_b = distortedUV - direction * aberrationOffset * 0.8;
    newImg = vec4(photo(uTexture2, uv_r).r, photo(uTexture2, uv_g).g, photo(uTexture2, uv_b).b, 1.0);
  } else {
    newImg = photo(uTexture2, uv2_base);
  }
  if (inside > 0.0 && rimLightIntensity > 0.0) {
    float rim = smoothstep(1.0 - rimLightWidth, 1.0, normalizedDist) *
      (1.0 - smoothstep(1.0, 1.01, normalizedDist));
    newImg.rgb += rim * rimLightIntensity;
    float edge = smoothstep(1.0 - glassEdgeWidth, 1.0, normalizedDist) *
      (1.0 - smoothstep(1.0, 1.01, normalizedDist));
    newImg.rgb = mix(newImg.rgb, vec3(1.0), edge * glassEdgeOpacity);
  }
  vec4 currentImg = photo(uTexture1, uv1);
  if (progress > 0.95) {
    newImg = mix(newImg, photo(uTexture2, uv2_base), (progress - 0.95) / 0.05);
  }
  return mix(currentImg, newImg, inside);
}
void main() { gl_FragColor = glassEffect(vUv, uProgress); }
`;
