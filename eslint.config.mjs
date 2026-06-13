import { config as baseConfig } from "@devin/eslint-config/base";
import { config as reactInternalConfig } from "@devin/eslint-config/react-internal";
import { nextJsConfig } from "@devin/eslint-config/next-js";

export default [...baseConfig, ...reactInternalConfig, ...nextJsConfig];
