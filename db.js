// db.js
const { Sequelize } = require('sequelize');

// Connect to your MySQL database "myapp" (create it via phpMyAdmin in XAMPP)
const sequelize = new Sequelize('myapp', 'root', '', {
  host: 'localhost',
  dialect: 'mysql'
});

sequelize.authenticate()
  .then(() => console.log("MySQL connected via XAMPP..."))
  .catch(err => console.error("MySQL connection error:", err));

module.exports = sequelize;
