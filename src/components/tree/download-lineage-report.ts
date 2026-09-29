import { fullName, type Family } from "../../domain";
import {
  lineageReport,
  type LineageDirection,
} from "../../domain/lineage-report";

export function downloadLineageReport(
  family: Family,
  personId: string | undefined,
  direction: LineageDirection,
  generations: number,
) {
  const person = family.people.find((item) => item.id === personId);
  if (!person) throw new Error("Выберите человека для росписи.");
  const content = lineageReport(family, person.id, direction, generations);
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `Роспись ${fullName(person).replace(/[<>:"/\\|?*]/g, "_")}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
