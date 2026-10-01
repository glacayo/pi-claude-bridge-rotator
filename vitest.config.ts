// Vitest configuration.
//
// Deliberately import-free: Vitest reads the default export directly, and this
// avoids depending on `vitest/config` types at config-load time.
const config = {
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
};

export default config;
