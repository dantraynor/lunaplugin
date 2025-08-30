
import React from "react";
import { LunaSettings, LunaSwitchSetting } from "@luna/ui";
import { trace } from "./index.js";

export const Settings = () => {
	const [checked, setChecked] = React.useState(false);
	const onChange = React.useCallback((_: any, checked?: boolean) => {
		trace.msg.log(`MultiplePlaylists switch is now ${checked ? "on" : "off"}`);
		setChecked(checked ?? false);
	}, []);
	return (
		<LunaSettings>
			<LunaSwitchSetting title="Enable Multiple Playlists" checked={checked} desc="Toggle the multiple playlists feature" onChange={onChange} />
		</LunaSettings>
	);
};
