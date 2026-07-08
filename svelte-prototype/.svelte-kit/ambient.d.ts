
// this file is generated — do not edit it


/// <reference types="@sveltejs/kit" />

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module only includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/private';
 * 
 * console.log(ENVIRONMENT); // => "production"
 * console.log(PUBLIC_BASE_URL); // => throws error during build
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/private' {
	export const SHELL: string;
	export const npm_command: string;
	export const COREPACK_ENABLE_AUTO_PIN: string;
	export const npm_config_userconfig: string;
	export const __TELEMETRY_CLIENT_ID: string;
	export const npm_config_cache: string;
	export const CLAUDE_CODE_CHILD_SESSION: string;
	export const NVM_INC: string;
	export const HISTCONTROL: string;
	export const XDG_MENU_PREFIX: string;
	export const QT_IM_MODULES: string;
	export const rvm_prefix: string;
	export const AI_AGENT: string;
	export const CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: string;
	export const HISTSIZE: string;
	export const HOSTNAME: string;
	export const BASH_IT: string;
	export const CLAUDE_CODE_SESSION_ID: string;
	export const NODE: string;
	export const GIT_PS1_SHOWUPSTREAM: string;
	export const SSH_AUTH_SOCK: string;
	export const GIT_PS1_SHOWDIRTYSTATE: string;
	export const CLAUDE_EFFORT: string;
	export const MEMORY_PRESSURE_WRITE: string;
	export const ELECTRON_RUN_AS_NODE: string;
	export const MY_RUBY_HOME: string;
	export const COLOR: string;
	export const npm_config_local_prefix: string;
	export const XMODIFIERS: string;
	export const DESKTOP_SESSION: string;
	export const CLAUDE_CODE_ENABLE_TASKS: string;
	export const NO_AT_BRIDGE: string;
	export const npm_config_globalconfig: string;
	export const _printf_cmd: string;
	export const GPG_TTY: string;
	export const EDITOR: string;
	export const RUBY_VERSION: string;
	export const PWD: string;
	export const LOGNAME: string;
	export const XDG_SESSION_DESKTOP: string;
	export const XDG_SESSION_TYPE: string;
	export const rvm_version: string;
	export const VSCODE_ESM_ENTRYPOINT: string;
	export const npm_config_init_module: string;
	export const SYSTEMD_EXEC_PID: string;
	export const VSCODE_CODE_CACHE_PATH: string;
	export const _: string;
	export const XAUTHORITY: string;
	export const SDL_VIDEO_MINIMIZE_ON_FOCUS_LOSS: string;
	export const NoDefaultCurrentDirectoryInExePath: string;
	export const TODO: string;
	export const GIT_PS1_SHOWCOLORHINTS: string;
	export const GJS_DEBUG_TOPICS: string;
	export const CLAUDECODE: string;
	export const GDM_LANG: string;
	export const GIT_HOSTING: string;
	export const HOME: string;
	export const USERNAME: string;
	export const CLAUDE_AGENT_SDK_VERSION: string;
	export const SSH_ASKPASS: string;
	export const LANG: string;
	export const XDG_CURRENT_DESKTOP: string;
	export const npm_package_version: string;
	export const MEMORY_PRESSURE_WATCH: string;
	export const VSCODE_IPC_HOOK: string;
	export const WAYLAND_DISPLAY: string;
	export const PERL5LIB: string;
	export const VSCODE_L10N_BUNDLE_LOCATION: string;
	export const INVOCATION_ID: string;
	export const MANAGERPID: string;
	export const INIT_CWD: string;
	export const CHROME_DESKTOP: string;
	export const STEAM_FRAME_FORCE_CLOSE: string;
	export const npm_lifecycle_script: string;
	export const GJS_DEBUG_OUTPUT: string;
	export const MOZ_GMP_PATH: string;
	export const NVM_DIR: string;
	export const GNOME_SETUP_DISPLAY: string;
	export const rvm_bin_path: string;
	export const GEM_PATH: string;
	export const npm_config_npm_version: string;
	export const GEM_HOME: string;
	export const XDG_SESSION_CLASS: string;
	export const npm_package_name: string;
	export const IRC_CLIENT: string;
	export const PERL_MB_OPT: string;
	export const npm_config_prefix: string;
	export const LESSOPEN: string;
	export const MYSQL_PS1: string;
	export const USER: string;
	export const CLAUDE_CODE_ENABLE_TELEMETRY: string;
	export const BASH_IT_THEME: string;
	export const PERL_MM_OPT: string;
	export const DISPLAY: string;
	export const npm_lifecycle_event: string;
	export const VSCODE_PID: string;
	export const SHLVL: string;
	export const NVM_CD_FLAGS: string;
	export const GIT_EDITOR: string;
	export const QT_IM_MODULE: string;
	export const VSCODE_CWD: string;
	export const MANAGERPIDFDID: string;
	export const npm_config_user_agent: string;
	export const AWS_SDK_LOAD_CONFIG: string;
	export const npm_execpath: string;
	export const FC_FONTATIONS: string;
	export const VSCODE_CRASH_REPORTER_PROCESS_TYPE: string;
	export const XDG_RUNTIME_DIR: string;
	export const CLAUDE_CODE_ENTRYPOINT: string;
	export const DEBUGINFOD_URLS: string;
	export const npm_package_json: string;
	export const DEBUGINFOD_IMA_CERT_PATH: string;
	export const KDEDIRS: string;
	export const MCP_CONNECTION_NONBLOCKING: string;
	export const JOURNAL_STREAM: string;
	export const XDG_DATA_DIRS: string;
	export const PERL_LOCAL_LIB_ROOT: string;
	export const GDK_BACKEND: string;
	export const CLAUDE_CODE_EXECPATH: string;
	export const npm_config_noproxy: string;
	export const PATH: string;
	export const __GLX_VENDOR_LIBRARY_NAME: string;
	export const npm_config_node_gyp: string;
	export const GDMSESSION: string;
	export const DBUS_SESSION_BUS_ADDRESS: string;
	export const npm_config_global_prefix: string;
	export const VSCODE_NLS_CONFIG: string;
	export const __VK_LAYER_NV_optimus: string;
	export const MAIL: string;
	export const NVM_BIN: string;
	export const GIT_PS1_SHOWUNTRACKEDFILES: string;
	export const __NV_PRIME_RENDER_OFFLOAD: string;
	export const IRBRC: string;
	export const GIT_PS1_HIDE_IF_PWD_IGNORED: string;
	export const GIO_LAUNCHED_DESKTOP_FILE_PID: string;
	export const npm_node_execpath: string;
	export const npm_config_engine_strict: string;
	export const GIO_LAUNCHED_DESKTOP_FILE: string;
	export const VSCODE_HANDLES_UNCAUGHT_ERRORS: string;
	export const rvm_path: string;
	export const GOPATH: string;
	export const SCM_CHECK: string;
	export const NODE_ENV: string;
}

/**
 * This module provides access to environment variables that are injected _statically_ into your bundle at build time and are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Static environment variables are [loaded by Vite](https://vitejs.dev/guide/env-and-mode.html#env-files) from `.env` files and `process.env` at build time and then statically injected into your bundle at build time, enabling optimisations like dead code elimination.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * For example, given the following build time environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { ENVIRONMENT, PUBLIC_BASE_URL } from '$env/static/public';
 * 
 * console.log(ENVIRONMENT); // => throws error during build
 * console.log(PUBLIC_BASE_URL); // => "http://site.com"
 * ```
 * 
 * The above values will be the same _even if_ different values for `ENVIRONMENT` or `PUBLIC_BASE_URL` are set at runtime, as they are statically replaced in your code with their build time values.
 */
declare module '$env/static/public' {
	
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are limited to _private_ access.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Private_ access:**
 * 
 * - This module cannot be imported into client-side code
 * - This module includes variables that _do not_ begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) _and do_ start with [`config.kit.env.privatePrefix`](https://svelte.dev/docs/kit/configuration#env) (if configured)
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://site.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/private';
 * 
 * console.log(env.ENVIRONMENT); // => "production"
 * console.log(env.PUBLIC_BASE_URL); // => undefined
 * ```
 */
declare module '$env/dynamic/private' {
	export const env: {
		SHELL: string;
		npm_command: string;
		COREPACK_ENABLE_AUTO_PIN: string;
		npm_config_userconfig: string;
		__TELEMETRY_CLIENT_ID: string;
		npm_config_cache: string;
		CLAUDE_CODE_CHILD_SESSION: string;
		NVM_INC: string;
		HISTCONTROL: string;
		XDG_MENU_PREFIX: string;
		QT_IM_MODULES: string;
		rvm_prefix: string;
		AI_AGENT: string;
		CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: string;
		HISTSIZE: string;
		HOSTNAME: string;
		BASH_IT: string;
		CLAUDE_CODE_SESSION_ID: string;
		NODE: string;
		GIT_PS1_SHOWUPSTREAM: string;
		SSH_AUTH_SOCK: string;
		GIT_PS1_SHOWDIRTYSTATE: string;
		CLAUDE_EFFORT: string;
		MEMORY_PRESSURE_WRITE: string;
		ELECTRON_RUN_AS_NODE: string;
		MY_RUBY_HOME: string;
		COLOR: string;
		npm_config_local_prefix: string;
		XMODIFIERS: string;
		DESKTOP_SESSION: string;
		CLAUDE_CODE_ENABLE_TASKS: string;
		NO_AT_BRIDGE: string;
		npm_config_globalconfig: string;
		_printf_cmd: string;
		GPG_TTY: string;
		EDITOR: string;
		RUBY_VERSION: string;
		PWD: string;
		LOGNAME: string;
		XDG_SESSION_DESKTOP: string;
		XDG_SESSION_TYPE: string;
		rvm_version: string;
		VSCODE_ESM_ENTRYPOINT: string;
		npm_config_init_module: string;
		SYSTEMD_EXEC_PID: string;
		VSCODE_CODE_CACHE_PATH: string;
		_: string;
		XAUTHORITY: string;
		SDL_VIDEO_MINIMIZE_ON_FOCUS_LOSS: string;
		NoDefaultCurrentDirectoryInExePath: string;
		TODO: string;
		GIT_PS1_SHOWCOLORHINTS: string;
		GJS_DEBUG_TOPICS: string;
		CLAUDECODE: string;
		GDM_LANG: string;
		GIT_HOSTING: string;
		HOME: string;
		USERNAME: string;
		CLAUDE_AGENT_SDK_VERSION: string;
		SSH_ASKPASS: string;
		LANG: string;
		XDG_CURRENT_DESKTOP: string;
		npm_package_version: string;
		MEMORY_PRESSURE_WATCH: string;
		VSCODE_IPC_HOOK: string;
		WAYLAND_DISPLAY: string;
		PERL5LIB: string;
		VSCODE_L10N_BUNDLE_LOCATION: string;
		INVOCATION_ID: string;
		MANAGERPID: string;
		INIT_CWD: string;
		CHROME_DESKTOP: string;
		STEAM_FRAME_FORCE_CLOSE: string;
		npm_lifecycle_script: string;
		GJS_DEBUG_OUTPUT: string;
		MOZ_GMP_PATH: string;
		NVM_DIR: string;
		GNOME_SETUP_DISPLAY: string;
		rvm_bin_path: string;
		GEM_PATH: string;
		npm_config_npm_version: string;
		GEM_HOME: string;
		XDG_SESSION_CLASS: string;
		npm_package_name: string;
		IRC_CLIENT: string;
		PERL_MB_OPT: string;
		npm_config_prefix: string;
		LESSOPEN: string;
		MYSQL_PS1: string;
		USER: string;
		CLAUDE_CODE_ENABLE_TELEMETRY: string;
		BASH_IT_THEME: string;
		PERL_MM_OPT: string;
		DISPLAY: string;
		npm_lifecycle_event: string;
		VSCODE_PID: string;
		SHLVL: string;
		NVM_CD_FLAGS: string;
		GIT_EDITOR: string;
		QT_IM_MODULE: string;
		VSCODE_CWD: string;
		MANAGERPIDFDID: string;
		npm_config_user_agent: string;
		AWS_SDK_LOAD_CONFIG: string;
		npm_execpath: string;
		FC_FONTATIONS: string;
		VSCODE_CRASH_REPORTER_PROCESS_TYPE: string;
		XDG_RUNTIME_DIR: string;
		CLAUDE_CODE_ENTRYPOINT: string;
		DEBUGINFOD_URLS: string;
		npm_package_json: string;
		DEBUGINFOD_IMA_CERT_PATH: string;
		KDEDIRS: string;
		MCP_CONNECTION_NONBLOCKING: string;
		JOURNAL_STREAM: string;
		XDG_DATA_DIRS: string;
		PERL_LOCAL_LIB_ROOT: string;
		GDK_BACKEND: string;
		CLAUDE_CODE_EXECPATH: string;
		npm_config_noproxy: string;
		PATH: string;
		__GLX_VENDOR_LIBRARY_NAME: string;
		npm_config_node_gyp: string;
		GDMSESSION: string;
		DBUS_SESSION_BUS_ADDRESS: string;
		npm_config_global_prefix: string;
		VSCODE_NLS_CONFIG: string;
		__VK_LAYER_NV_optimus: string;
		MAIL: string;
		NVM_BIN: string;
		GIT_PS1_SHOWUNTRACKEDFILES: string;
		__NV_PRIME_RENDER_OFFLOAD: string;
		IRBRC: string;
		GIT_PS1_HIDE_IF_PWD_IGNORED: string;
		GIO_LAUNCHED_DESKTOP_FILE_PID: string;
		npm_node_execpath: string;
		npm_config_engine_strict: string;
		GIO_LAUNCHED_DESKTOP_FILE: string;
		VSCODE_HANDLES_UNCAUGHT_ERRORS: string;
		rvm_path: string;
		GOPATH: string;
		SCM_CHECK: string;
		NODE_ENV: string;
		[key: `PUBLIC_${string}`]: undefined;
		[key: `${string}`]: string | undefined;
	}
}

/**
 * This module provides access to environment variables set _dynamically_ at runtime and that are _publicly_ accessible.
 * 
 * |         | Runtime                                                                    | Build time                                                               |
 * | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
 * | Private | [`$env/dynamic/private`](https://svelte.dev/docs/kit/$env-dynamic-private) | [`$env/static/private`](https://svelte.dev/docs/kit/$env-static-private) |
 * | Public  | [`$env/dynamic/public`](https://svelte.dev/docs/kit/$env-dynamic-public)   | [`$env/static/public`](https://svelte.dev/docs/kit/$env-static-public)   |
 * 
 * Dynamic environment variables are defined by the platform you're running on. For example if you're using [`adapter-node`](https://github.com/sveltejs/kit/tree/main/packages/adapter-node) (or running [`vite preview`](https://svelte.dev/docs/kit/cli)), this is equivalent to `process.env`.
 * 
 * **_Public_ access:**
 * 
 * - This module _can_ be imported into client-side code
 * - **Only** variables that begin with [`config.kit.env.publicPrefix`](https://svelte.dev/docs/kit/configuration#env) (which defaults to `PUBLIC_`) are included
 * 
 * > [!NOTE] In `dev`, `$env/dynamic` includes environment variables from `.env`. In `prod`, this behavior will depend on your adapter.
 * 
 * > [!NOTE] To get correct types, environment variables referenced in your code should be declared (for example in an `.env` file), even if they don't have a value until the app is deployed:
 * >
 * > ```env
 * > MY_FEATURE_FLAG=
 * > ```
 * >
 * > You can override `.env` values from the command line like so:
 * >
 * > ```sh
 * > MY_FEATURE_FLAG="enabled" npm run dev
 * > ```
 * 
 * For example, given the following runtime environment:
 * 
 * ```env
 * ENVIRONMENT=production
 * PUBLIC_BASE_URL=http://example.com
 * ```
 * 
 * With the default `publicPrefix` and `privatePrefix`:
 * 
 * ```ts
 * import { env } from '$env/dynamic/public';
 * console.log(env.ENVIRONMENT); // => undefined, not public
 * console.log(env.PUBLIC_BASE_URL); // => "http://example.com"
 * ```
 * 
 * ```
 * 
 * ```
 */
declare module '$env/dynamic/public' {
	export const env: {
		[key: `PUBLIC_${string}`]: string | undefined;
	}
}
