import { Router } from "express";
import { dashboardService } from "../brain/DashboardService";

const router = Router();

router.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

router.get("/brain/status", async (req, res) => {
  try {
    const status = await dashboardService.getBrainStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch brain status" });
  }
});

export default router;
