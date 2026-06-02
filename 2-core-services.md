# 2. Core Services

## Relevant Source Files
* `tests/UnitTests/ApplicationCore/Services/BasketServiceTests/TransferBasket.cs`
* `src/ApplicationCore/Services/BasketService.cs`
* `src/ApplicationCore/Services/OrderService.cs`
* `src/ApplicationCore/Services/UriComposer.cs`
* `tests/UnitTests/ApplicationCore/Services/BasketServiceTests/AddItemToBasket.cs`
* `tests/UnitTests/ApplicationCore/Services/BasketServiceTests/DeleteBasket.cs`
* `tests/UnitTests/ApplicationCore/Extensions/JsonExtensions.cs`
* `tests/UnitTests/ApplicationCore/Extensions/TestParent.cs`
* `src/Web/Configuration/ConfigureWebServices.cs`
* `src/PublicApi/Extensions/ServiceCollectionExtensions.cs`

## Purpose and Scope
The Core Services module encapsulates the business logic of the application, providing a layer of abstraction between the presentation and data access layers. This module contains services that interact with the database to retrieve or update data, as well as services that orchestrate complex business processes.

### Service-Oriented Architecture
The Core Services module follows a service-oriented architecture (SOA), where each service is responsible for a specific business capability. For example, the BasketService manages user baskets, while the OrderService handles order processing. This design enables loose coupling between services and facilitates scalability and maintainability.

### Pattern: Repository Pattern
In this module, we employ the Repository Pattern to abstract data access. The `BasketRepository` interface defines methods for retrieving and updating basket data, which are implemented by concrete repositories that interact with the database. This pattern decouples business logic from data access concerns, making it easier to swap out different data storage solutions.

### Integration with Other Components
The Core Services module interacts closely with other components in the system, such as the Domain Entities (see [1. Domain Model](1-domain-model.md)) and Data Access layers (see [3. Data Access](3-data-access.md)). The services in this module rely on these components to perform data retrieval and updates.

### Key Design Decisions
One key design decision was to use a service-oriented architecture, which enables us to partition the system into smaller, more manageable pieces. Another decision was to employ the Repository Pattern, which helps decouple business logic from data access concerns.

## [Basket Service]

The BasketService is responsible for managing user baskets. It provides methods for adding and removing items from a basket, as well as for retrieving the contents of a basket.

### Methods

| Method | Type/Parameters | Description | Source Location |
| --- | --- | --- | --- |
| AddItemToBasket | void (Guid userId, BasketItem item) | Adds an item to a user's basket. | `tests/UnitTests/ApplicationCore/Services/BasketServiceTests/AddItemToBasket.cs:20-25` |
| RemoveItemFromBasket | void (Guid userId, BasketItem item) | Removes an item from a user's basket. | `tests/UnitTests/ApplicationCore/Services/BasketServiceTests/DeleteBasket.cs:15-20` |

### Integration with Other Components
The BasketService interacts with the Domain Entities (see [1. Domain Model](1-domain-model.md)) to retrieve and update basket data. It also relies on the Repository Pattern (see [3. Data Access](3-data-access.md)) to interact with the database.

## [Order Service]

The OrderService is responsible for handling order processing, including creating new orders, updating order status, and retrieving order information.

### Methods

| Method | Type/Parameters | Description | Source Location |
| --- | --- | --- | --- |
| CreateOrderAsync | Task<Order> (Guid userId) | Creates a new order for a user. | `src/ApplicationCore/Services/OrderService.cs:40-45` |
| UpdateOrderStatus | void (Guid orderId, OrderStatus status) | Updates the status of an existing order. | `tests/UnitTests/ApplicationCore/Services/BasketServiceTests/TransferBasket.cs:60-65` |

### Integration with Other Components
The OrderService interacts with the Domain Entities (see [1. Domain Model](1-domain-model.md)) to retrieve and update order data. It also relies on the Repository Pattern (see [3. Data Access](3-data-access.md)) to interact with the database.

## Integration with Other Components

The Core Services module integrates closely with other components in the system, such as:

* The Domain Entities (see [1. Domain Model](1-domain-model.md)), which provide a layer of abstraction between the business logic and data access layers.
* The Data Access layers (see [3. Data Access](3-data-access.md)), which interact with the database to retrieve or update data.

### Integration Diagram

```mermaid
sequenceDiagram
    participant BasketService as "Basket Service"
    participant OrderService as "Order Service"
    participant DomainEntities as "Domain Entities"
    participant Database as "Database"

    note over BasketService, OrderService: "Services interact with each other to manage user baskets and order processing."
    activate BasketService
    BasketService->>OrderService: Create new order
    OrderService->>BasketService: Update basket contents
    deactivate BasketService

    note over DomainEntities, Database: "Domain Entities abstractly represent business logic, while the Database provides data storage."
    activate DomainEntities
    DomainEntities->>BasketService: Retrieve basket information
    DomainEntities->>OrderService: Retrieve order information
    deactivate DomainEntities

    note over BasketService, OrderService, Database: "Services interact with Domain Entities and Database to perform business logic and data access operations."
```

### Call Chains

* CreatesNewUserBasketIfNotExists (tests/UnitTests/ApplicationCore/Services/BasketServiceTests/TransferBasket.cs:88) → RemovesAnonymousBasketAfterUpdatingUserBasket (tests/UnitTests/ApplicationCore/Services/BasketServiceTests/TransferBasket.cs:72) → TransferAnonymousBasketItemsWhilePreservingExistingUserBasketItems (tests/UnitTests/ApplicationCore/Services/BasketServiceTests/TransferBasket.cs:48) → InvokesBasketRepositoryFirstOrDefaultAsyncOnceIfAnonymousBasketNotExists (tests/UnitTests/ApplicationCore/Services/BasketServiceTests/TransferBasket.cs:32) → Then (tests/UnitTests/ApplicationCore/Services/BasketServiceTests/TransferBasket.cs:24)

### Cross-References

* For more information on the Domain Entities, see [1. Domain Model](1-domain-model.md).
* For details on the Data Access layers, see [3. Data Access](3-data-access.md).

---

**Navigation:**
[← Table of Contents](index.md) | [← 1.2. Value Objects](1.2-value-objects.md) | [2.1. Basket Service →](2.1-basket-service.md)

**In this section:**
- [2.1. Basket Service](2.1-basket-service.md)
- [2.2. Order Service](2.2-order-service.md)