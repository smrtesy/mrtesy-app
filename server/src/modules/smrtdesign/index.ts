import { Router } from "express";
import designRouter from "./routes";

const router = Router();
router.use(designRouter);

export default router;
