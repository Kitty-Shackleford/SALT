const express = require('express');
const router = express.Router();
const validationService = require('../services/validationService');

// Validate file content
router.post('/validate/:fileType', async (req, res) => {
  const { fileType } = req.params;
  const { fileName, content } = req.body;

  if (!content) {
    return res.status(400).json({ success: false, error: 'Content required' });
  }

  try {
    let result;

    if (fileType === 'xml') {
      result = await validationService.validateXML(fileName, content);
    } else if (fileType === 'json') {
      result = validationService.validateJSON(fileName, content);
    } else {
      return res.status(400).json({ success: false, error: 'Invalid file type' });
    }

    const summary = validationService.getValidationSummary(result);

    res.json({
      success: true,
      validation: result,
      summary
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Lint and auto-fix
router.post('/lint/:fileType', async (req, res) => {
  const { fileType } = req.params;
  const { fileName, content } = req.body;

  if (!content) {
    return res.status(400).json({ success: false, error: 'Content required' });
  }

  try {
    const result = await validationService.lintAndFix(fileName, content, fileType);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;