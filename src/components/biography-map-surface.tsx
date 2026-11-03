import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIconRetina from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import type { BiographyMap } from "../domain/biography-map";

// Leaflet's standard assets, with explicit bundled URLs for production builds.
const standardMarker = L.icon({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIconRetina,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  tooltipAnchor: [16, -28],
  shadowSize: [41, 41],
});

export function mountBiographyMap(
  host: HTMLElement,
  data: BiographyMap,
  options: {
    interactive?: boolean;
  } = {},
) {
  const interactive = options.interactive !== false;
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  const map = L.map(host, {
    zoomAnimation: !reducedMotion,
    markerZoomAnimation: !reducedMotion,
    fadeAnimation: !reducedMotion,
    zoomControl: false,
    dragging: interactive,
    touchZoom: interactive,
    doubleClickZoom: interactive,
    scrollWheelZoom: interactive,
    boxZoom: interactive,
    keyboard: interactive,
  }).setView([53, 37], 4);
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  if (interactive)
    L.control
      .zoom({
        position: "bottomright",
        zoomInTitle: "Увеличить масштаб",
        zoomOutTitle: "Уменьшить масштаб",
      })
      .addTo(map);
  let layer: L.GeoJSON | undefined,
    fitted = false,
    previousGeometry = "";
  let previousData: BiographyMap | undefined;
  const update = (next: BiographyMap) => {
    if (previousData === next) return;
    if (layer) map.removeLayer(layer);
    layer = L.geoJSON(next, {
      style: () => ({ color: "#9d563f", weight: 3, fillOpacity: 0.12 }),
      pointToLayer: (feature, point) =>
        L.marker(point, {
          icon: standardMarker,
          alt:
            typeof feature.properties?.name === "string"
              ? feature.properties.name
              : "Точка маршрута",
          keyboard: interactive,
          interactive,
          riseOnHover: true,
          bubblingMouseEvents: false,
        }),
      onEachFeature: (feature, item) => {
        if (!interactive) return;
        const properties = feature.properties || {};
        const title =
          typeof properties.name === "string" && properties.name
            ? properties.name
            : typeof properties.title === "string"
              ? properties.title
              : "";
        const date = typeof properties.date === "string" ? properties.date : "";
        const description =
          typeof properties.description === "string"
            ? properties.description
            : "";
        if (!title && !date && !description) return;
        const label = (full: boolean) => {
          const content = document.createElement("div");
          content.className = "biography-map-label";
          for (const [tag, value] of [
            ["strong", title || "Точка маршрута"],
            ["span", date],
            ["p", full ? description : ""],
          ]) {
            if (!value) continue;
            const node = document.createElement(tag);
            node.textContent = value;
            content.append(node);
          }
          return content;
        };
        item.bindTooltip(label(false), {
          className: "biography-map-tooltip",
          direction: "auto",
          opacity: 1,
        });
        item.bindPopup(label(true), {
          className: "biography-map-popup",
          maxWidth: 300,
          minWidth: 180,
          maxHeight: 240,
        });
      },
    }).addTo(map);
    const geometryKey = JSON.stringify(next.features.map((f) => f.geometry));
    if (
      layer.getBounds().isValid() &&
      (!fitted ||
        (geometryKey !== previousGeometry &&
          !map.getBounds().contains(layer.getBounds())))
    ) {
      map.fitBounds(layer.getBounds(), {
        maxZoom: 11,
        padding: [25, 25],
        animate: false,
      });
      fitted = true;
    }
    previousGeometry = geometryKey;
    previousData = next;
  };
  update(data);
  const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
  observer.observe(host);
  return {
    update,
    destroy() {
      observer.disconnect();
      map.remove();
    },
  };
}

export default function BiographyMapSurface({ data }: { data: BiographyMap }) {
  const host = useRef<HTMLDivElement>(null),
    instance = useRef<ReturnType<typeof mountBiographyMap> | null>(null);
  useEffect(() => {
    instance.current = mountBiographyMap(host.current!, data);
    return () => {
      instance.current?.destroy();
      instance.current = null;
    };
    // The map owns its viewport; updated data must not recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    instance.current?.update(data);
  }, [data]);
  return (
    <div
      ref={host}
      className="biography-map-surface"
      aria-label="Карта жизни"
    />
  );
}
