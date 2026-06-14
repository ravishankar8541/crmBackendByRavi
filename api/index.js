require('dotenv').config();
const express = require('express');
const app = express();
const path = require('path');
const cors = require('cors');
const dbConnection = require('../config/db'); 
const auth = require('../routes/auth')
const client = require('../routes/client')
const billRoutes = require('../routes/billRoutes');
const serviceBillRoutes = require('../routes/serviceBillRoutes');

const PORT = process.env.PORT || 5000;

dbConnection();

app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'], 
  credentials: true,               
}));
app.use(express.json());

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api/auth', auth);
app.use('/api/client', client);
app.use('/api/bills', billRoutes);
app.use('/api/service-bills', serviceBillRoutes);

app.get('/', (req, res) => {
  res.status(200).json({
    status: "success",
    message: "ViralCRM Backend is Live and Running perfectly!",
    timestamp: new Date()
  });
});

app.get('/uploads/debug-test', (req, res) => {
  res.send('Static middleware is active!');
});
app.listen(PORT, () => {
  console.log(`Server is running on PORT ${PORT}`);
});