import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { BiographyMap } from "../domain/biography-map";

export function mountBiographyMap(
  host: HTMLElement,
  data: BiographyMap,
  options: {
    interactive?: boolean;
  } = {},
) {
  const interactive = options.interactive !== false;
  const map = L.map(host, {
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
  const update = (next: BiographyMap) => {
    if (layer) map.removeLayer(layer);
    layer = L.geoJSON(next, {
      style: () => ({ color: "#9d563f", weight: 3, fillOpacity: 0.12 }),
      pointToLayer: (_feature, point) =>
        L.circleMarker(point, {
          radius: interactive ? 7 : 5,
          color: "#824430",
          fillColor: "#c37b4c",
          fillOpacity: 1,
          weight: 2,
          bubblingMouseEvents: false,
        }),
      onEachFeature: (feature, item) => {
        const values = [
          feature.properties?.name || feature.properties?.title,
          feature.properties?.date,
          feature.properties?.description,
        ].filter((v) => typeof v === "string" && v);
        if (!values.length) return;
        const label = document.createElement("div");
        label.className = "biography-map-label";
        label.textContent = values.join("\n");
        item.bindTooltip(label);
        if (interactive) item.bindPopup(label.cloneNode(true) as HTMLElement);
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
