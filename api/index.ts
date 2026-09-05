import { createApp } from "../src/app";

const app = createApp();

export default (req: any, res: any) => {
  return app(req, res);
};
