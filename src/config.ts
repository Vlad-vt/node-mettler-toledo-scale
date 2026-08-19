export const PORT = 3000;
export const PORT_HTTPS = 8443;
export const OUT_PIPE_PATH: string = `\\\\.\\pipe\\VCOOut`;
export const IN_PIPE_PATH: string = `\\\\.\\pipe\\VCOIn`;
export const TRIGGER_STABLE_PIPE_PATH: string = `\\\\.\\pipe\\VCOTriggerStableWeight`;

// VCODisp's own config file. We READ its <trigger_stable state="..."> to decide
// whether FreshAI should be active, and (only if the line is missing) we ADD it.
// The restart scripts (stop/run vcodisp.bat) live in the sibling ../bin folder.
export const VCODISP_XML_PATH: string =
    'C:\\Program Files (x86)\\Mettler Toledo\\MTOpos\\VCODisp\\etc\\vcodisp.xml';

// export const OUT_PIPE_PATH: string = `\\\\.\\pipe\\NODEOut`;
// export const IN_PIPE_PATH: string = `\\\\.\\pipe\\NODEIn`;
