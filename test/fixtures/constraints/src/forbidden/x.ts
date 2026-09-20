// allowDeny violation: domain:framework may import nothing else.
import { sqlCore } from "../sql/core/a.js";

export const x = sqlCore;
