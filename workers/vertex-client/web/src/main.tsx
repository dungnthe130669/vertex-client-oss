import { render } from "preact";
import { App } from "./app";
import { go } from "./chat";
import { registerSw } from "./update";
import { trackViewport } from "./viewport";
import { installDialogFocus } from "./dialog-focus";
import { installOverlayChrome } from "./overlay-chrome";
import { getSpace } from "./space";
import "./styles.css";

getSpace(); // reads vc.space / ?space= and sets data-space on <html> before the first paint
render(<App />, document.getElementById("app")!);
registerSw(go);
trackViewport();
installDialogFocus();
installOverlayChrome();
