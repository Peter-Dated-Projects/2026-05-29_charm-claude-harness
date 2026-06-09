import { upper } from "./src/upper.js";
import { reverse } from "./src/reverse.js";

const cmd = process.argv[2];
const input = process.argv[3];

if (cmd === "upper") {
  console.log(upper(input));
} else if (cmd === "reverse") {
  console.log(reverse(input));
}
