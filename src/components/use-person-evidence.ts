import { useEffect, useRef, useState } from "react";
import { archiveEntityAt } from "../domain/archive-routes";
import type { Family, Person } from "../domain/types";

type PersonTab = "bio" | "sources" | "discussion";
const evidenceHash =
  /^#drevo-(?:source|birth|death|event|union)-[a-f0-9]{2,16}$/;

/** Owns URL navigation, record focus and temporary highlighting inside a profile. */
export function usePersonEvidence(
  person: Person,
  unions: Family["unions"],
  canDiscuss: boolean,
) {
  const [tab, setTab] = useState<PersonTab>(() => {
    if (
      typeof window === "undefined" ||
      archiveEntityAt(window.location.pathname)?.id !== person.id
    )
      return "bio";
    if (canDiscuss && window.location.hash === "#discussion")
      return "discussion";
    return /^#drevo-source-[a-f0-9]{2,16}$/.test(window.location.hash)
      ? "sources"
      : "bio";
  });
  const content = useRef<HTMLDivElement>(null);
  const focused = useRef("");
  const [navigation, setNavigation] = useState(0);
  useEffect(() => {
    const navigate = () => {
      if (
        archiveEntityAt(window.location.pathname)?.id !== person.id ||
        !evidenceHash.test(window.location.hash)
      )
        return;
      focused.current = "";
      setTab(
        window.location.hash.startsWith("#drevo-source-") ? "sources" : "bio",
      );
      setNavigation((value) => value + 1);
    };
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, [person.id]);
  useEffect(() => {
    const hash = window.location.hash;
    const target = hash.slice(1);
    if (
      !evidenceHash.test(hash) ||
      archiveEntityAt(window.location.pathname)?.id !== person.id ||
      focused.current === target
    )
      return;
    const node = content.current?.querySelector<HTMLElement>(
      `[data-evidence="${target}"]`,
    );
    if (!node) return;
    focused.current = target;
    let applied = false;
    const frame = requestAnimationFrame(() => {
      applied = true;
      node.scrollIntoView({ block: "center", behavior: "instant" });
      node.focus({ preventScroll: true });
      node.classList.add("research-evidence-target");
    });
    return () => {
      cancelAnimationFrame(frame);
      node.classList.remove("research-evidence-target");
      if (!applied && focused.current === target) focused.current = "";
    };
  }, [person, unions, tab, navigation]);
  return { tab, setTab, content };
}
