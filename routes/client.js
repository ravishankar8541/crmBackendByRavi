const express = require('express');
const {addClient, clients, editClient, deleteClient} = require('../controllers/clientController');

const router = express.Router();
router.post('/add', addClient);
router.get('/clients', clients)
router.put('/edit/:id', editClient)
router.delete('/delete/:id', deleteClient)



module.exports = router;