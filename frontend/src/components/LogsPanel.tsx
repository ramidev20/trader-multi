import { Box, Typography } from "@mui/material";

export default function LogsPanel() {
  return (
    <Box sx={styles.container}>
      <Typography variant="h6" fontWeight={600} mb={2}>
        Activity Logs
      </Typography>

      <Box sx={styles.logBox}>System ready...</Box>
    </Box>
  );
}

/* ---------- STYLES ---------- */

const styles = {
  container: {
    height: "100%",
  },

  logBox: {
    height: "140px",
    overflowY: "auto",
    fontFamily: "monospace",
    fontSize: "14px",
    color: "#555",
    border: "1px solid #e0e0e0",
    borderRadius: 2,
    padding: 2,
    backgroundColor: "#fafafa",
  },
};
