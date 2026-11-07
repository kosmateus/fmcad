// Preserve the shipped document journals' JSON projection, including omitted optional fields.
export { hash } from "../../domain/engineering/common";
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
